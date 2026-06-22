// controllers/gdrive.js
//
// Google Drive backup integration. The studio admin connects a Google account
// once (OAuth2); the site then pushes a complete backup ZIP — finance ledger,
// every collection, uploaded files, AND the receipt images out of Cloudflare
// R2 — into a "Joint Printing Backups" folder in that account. This is the
// "eggs out of one basket" copy: if the site, Render, or Cloudflare goes down,
// the latest backup still sits in Drive where the owner can grab it.
//
// Required backend env vars (set these on Render):
//   GDRIVE_CLIENT_ID      — from the Google Cloud OAuth client (Web application)
//   GDRIVE_CLIENT_SECRET  — from the same OAuth client
//   GDRIVE_REDIRECT_URI   — optional; defaults to the production callback below.
//                           Must EXACTLY match an Authorized redirect URI on the
//                           OAuth client.
//
// Until CLIENT_ID + CLIENT_SECRET are set every endpoint reports
// configured:false and stays inert. Mirrors the QuickBooks integration's shape
// so the connect/refresh/callback flow is familiar.

const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const GoogleDriveAuth = require('../models/GoogleDriveAuth');
const backup = require('./backup');

const CLIENT_ID     = process.env.GDRIVE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.GDRIVE_REDIRECT_URI ||
  'https://jointprinting-backend.onrender.com/api/gdrive/callback';

const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const FILES_URL    = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL   = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_NAME  = 'Joint Printing Backups';
// drive.file = access ONLY to files this app creates (it can't read the rest of
// the Drive). userinfo.email is just so status can show which account is linked.
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

const isConfigured = () => !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

// ── OAuth token plumbing ─────────────────────────────────────────────────────
async function exchangeToken(params) {
  const r = await axios.post(TOKEN_URL, new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params,
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  });
  return r.data; // { access_token, expires_in, refresh_token?, scope, token_type, id_token? }
}

function applyToken(auth, tok) {
  auth.accessToken          = tok.access_token;
  // Google only returns refresh_token on the first consent — keep the old one.
  if (tok.refresh_token) auth.refreshToken = tok.refresh_token;
  auth.accessTokenExpiresAt = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
}

// A valid access token, refreshed if it's within 60s of expiry.
async function freshAccessToken(auth) {
  const ok = auth.accessToken && auth.accessTokenExpiresAt &&
    auth.accessTokenExpiresAt.getTime() - Date.now() > 60000;
  if (ok) return auth.accessToken;
  if (!auth.refreshToken) throw new Error('Google Drive is not connected (no refresh token).');
  const tok = await exchangeToken({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  applyToken(auth, tok);
  await auth.save();
  return auth.accessToken;
}

// ── Drive helpers ────────────────────────────────────────────────────────────
// The id of our backups folder, creating it (and verifying a remembered id
// still exists) as needed. Returns the folder id.
async function ensureFolder(auth, accessToken) {
  if (auth.folderId) {
    try {
      const r = await axios.get(`${FILES_URL}/${auth.folderId}`, {
        params: { fields: 'id,trashed' },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (r.data && r.data.id && !r.data.trashed) return auth.folderId;
    } catch (_) { /* folder gone — fall through and re-create */ }
  }
  const r = await axios.post(`${FILES_URL}?fields=id`, {
    name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder',
  }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
  auth.folderId = r.data.id;
  await auth.save();
  return auth.folderId;
}

// Resumable upload: stream a file from disk straight to Drive so a large backup
// never has to sit in memory. Returns the created Drive file { id, name, size }.
async function uploadFile(accessToken, folderId, filePath, fileName, mime, size) {
  const init = await axios.post(
    `${UPLOAD_URL}?uploadType=resumable&fields=id,name,size`,
    { name: fileName, parents: [folderId] },
    { headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(size),
      } });
  const sessionUrl = init.headers.location || init.headers.Location;
  if (!sessionUrl) throw new Error('Drive did not return a resumable upload URL.');
  const put = await axios.put(sessionUrl, fs.createReadStream(filePath), {
    headers: { 'Content-Type': mime, 'Content-Length': String(size) },
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  return put.data;
}

// Build a full backup ZIP and push it to Drive. Shared by the manual button and
// the weekly cron. Throws on failure (caller records auth.lastError). `reason`
// is just for the BackupLog note ('manual' | 'scheduled').
async function pushBackupToDrive(reason) {
  if (!isConfigured()) throw new Error('Google Drive is not configured on the backend.');
  const auth = await GoogleDriveAuth.findOne();
  if (!auth || !auth.refreshToken) throw new Error('Google Drive is not connected.');

  const fileName = backup.backupFileName();
  const tmpPath  = path.join(os.tmpdir(), fileName);

  try {
    const stats = await backup.writeBackupToFile(tmpPath);     // complete archive incl. R2 receipts
    const size  = fs.statSync(tmpPath).size;
    const accessToken = await freshAccessToken(auth);
    const folderId = await ensureFolder(auth, accessToken);
    const file = await uploadFile(accessToken, folderId, tmpPath, fileName, 'application/zip', size);

    auth.lastBackupAt    = new Date();
    auth.lastBackupName   = file.name || fileName;
    auth.lastBackupBytes  = size;
    auth.lastError        = '';
    await auth.save();
    return { ok: true, fileName: auth.lastBackupName, sizeBytes: size, reason, stats };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort temp cleanup */ }
  }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────
// GET /api/gdrive/status
const status = async (req, res) => {
  try {
    if (!isConfigured()) return res.json({ configured: false, connected: false });
    const auth = await GoogleDriveAuth.findOne();
    res.json({
      configured:     true,
      connected:      !!(auth && auth.refreshToken),
      email:          auth ? auth.email : '',
      folderId:       auth ? auth.folderId : '',
      connectedAt:    auth ? auth.connectedAt : null,
      lastBackupAt:   auth ? auth.lastBackupAt : null,
      lastBackupName: auth ? auth.lastBackupName : '',
      lastBackupBytes: auth ? auth.lastBackupBytes : 0,
      lastError:      auth ? auth.lastError : '',
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/gdrive/connect — hands back the Google authorize URL to open.
const connect = async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(400).json({ message: 'Google Drive is not configured. Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET on the backend.' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    let auth = await GoogleDriveAuth.findOne();
    if (!auth) auth = new GoogleDriveAuth();
    auth.pendingState = state;
    await auth.save();
    const url = `${AUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
      `&access_type=offline&prompt=consent&include_granted_scopes=true&state=${state}`;
    res.json({ url });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/gdrive/callback — Google redirects the browser here after consent.
// Public (no Bearer on a redirect) but gated by the random `state`.
const callback = async (req, res) => {
  const done = (msg, ok) => res.status(ok ? 200 : 400).send(
    `<html><body style="font-family:sans-serif;padding:40px;text-align:center">` +
    `<h2>${ok ? 'Google Drive connected ✓' : 'Google Drive connection failed'}</h2>` +
    `<p>${msg}</p>` +
    (ok ? `<script>setTimeout(function(){window.close()},1800)</script>` : '') +
    `</body></html>`);
  try {
    if (!isConfigured()) return done('Google Drive is not configured on the backend.', false);
    const { code, state } = req.query;
    const auth = await GoogleDriveAuth.findOne();
    if (!auth || !auth.pendingState || auth.pendingState !== state) {
      return done('Invalid or expired state — start the connection again from Studio.', false);
    }
    const tok = await exchangeToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    applyToken(auth, tok);
    if (!auth.refreshToken) {
      return done('Google did not return a refresh token. Remove this app at myaccount.google.com/permissions, then connect again.', false);
    }
    // Best-effort: record which account is linked, for the status display.
    try {
      const u = await axios.get(USERINFO_URL, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
      auth.email = (u.data && u.data.email) || '';
    } catch (_) { /* non-fatal */ }
    auth.pendingState = '';
    auth.connectedAt  = new Date();
    auth.lastError    = '';
    await auth.save();
    done('You can close this window and return to Studio.', true);
  } catch (e) {
    const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    done(detail, false);
  }
};

// POST /api/gdrive/disconnect
const disconnect = async (req, res) => {
  try {
    await GoogleDriveAuth.deleteMany({});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// POST /api/gdrive/backup-now — build + push a backup immediately.
const backupNow = async (req, res) => {
  try {
    const result = await pushBackupToDrive('manual');
    res.json(result);
  } catch (e) {
    const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    try {
      const auth = await GoogleDriveAuth.findOne();
      if (auth) { auth.lastError = detail; await auth.save(); }
    } catch (_) {}
    res.status(500).json({ message: detail });
  }
};

module.exports = { status, connect, callback, disconnect, backupNow, pushBackupToDrive, isConfigured };
