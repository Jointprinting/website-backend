// controllers/quickbooks.js
//
// QuickBooks Online connection — OAuth2 authorization-code flow, mirroring
// controllers/gdrive.js. The admin clicks "Connect QuickBooks" (→ /connect hands
// back Intuit's authorize URL), consents on Intuit, Intuit redirects the browser
// to /callback with ?code&state&realmId, we exchange the code for tokens and store
// the ONE connection. The refresh token then buys short-lived access tokens for
// reading invoices/payments and sending the pay-at-close preorder payment links.
//
// Config (host env): QBO_CLIENT_ID, QBO_CLIENT_SECRET (production keys from the
// Intuit developer app), optional QBO_REDIRECT_URI (defaults to the registered
// callback) and QBO_ENVIRONMENT ('production' | 'sandbox', default production).

const axios = require('axios');
const crypto = require('crypto');
const QuickbooksAuth = require('../models/QuickbooksAuth');

const CLIENT_ID     = process.env.QBO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.QBO_REDIRECT_URI ||
  'https://jointprinting-backend.onrender.com/api/quickbooks/callback';
const ENVIRONMENT   = (process.env.QBO_ENVIRONMENT || 'production').toLowerCase();

// Intuit endpoints (same for sandbox + production except the API host).
const AUTH_URL   = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL  = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const API_BASE   = ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';
const SCOPE = 'com.intuit.quickbooks.accounting';

const isConfigured = () => !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
const basicAuth = () => Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

// The Intuit authorize URL the admin's browser is sent to. Pure — unit-tested.
function buildAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

async function exchangeToken(params) {
  const r = await axios.post(TOKEN_URL, new URLSearchParams(params).toString(), {
    headers: {
      Authorization: `Basic ${basicAuth()}`,       // Intuit wants the client creds in the header, not the body
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    timeout: 20000,
  });
  return r.data; // { access_token, refresh_token, expires_in, x_refresh_token_expires_in, token_type }
}

// Copy a token response onto the stored connection. Pure (given a doc-like obj) —
// unit-tested. Intuit returns a fresh refresh_token on every exchange; keep the
// old one only if a response somehow omits it.
function applyToken(auth, tok) {
  auth.accessToken = tok.access_token;
  if (tok.refresh_token) auth.refreshToken = tok.refresh_token;
  auth.accessTokenExpiresAt = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  if (tok.x_refresh_token_expires_in) {
    auth.refreshTokenExpiresAt = new Date(Date.now() + Number(tok.x_refresh_token_expires_in) * 1000);
  }
}

// A valid access token, refreshed if it's within 60s of expiry. Exported for the
// services that will read invoices/payments + send payment links.
async function freshAccessToken(auth) {
  const ok = auth.accessToken && auth.accessTokenExpiresAt &&
    auth.accessTokenExpiresAt.getTime() - Date.now() > 60000;
  if (ok) return auth.accessToken;
  if (!auth.refreshToken) throw new Error('QuickBooks is not connected (no refresh token).');
  const tok = await exchangeToken({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  applyToken(auth, tok);
  await auth.save();
  return auth.accessToken;
}

// The connected company's name, best-effort (for the status display).
async function fetchCompanyName(accessToken, realmId) {
  try {
    const r = await axios.get(`${API_BASE}/v3/company/${realmId}/companyinfo/${realmId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      params: { minorversion: 65 }, timeout: 15000,
    });
    return (r.data && r.data.CompanyInfo && r.data.CompanyInfo.CompanyName) || '';
  } catch (_) { return ''; }
}

// GET /api/quickbooks/status — is it configured / connected, and to which company?
const status = async (req, res) => {
  try {
    if (!isConfigured()) return res.json({ configured: false, connected: false });
    const auth = await QuickbooksAuth.findOne();
    const connected = !!(auth && auth.refreshToken);
    res.json({
      configured: true,
      connected,
      environment: ENVIRONMENT,
      companyName: connected ? auth.companyName : '',
      realmId: connected ? auth.realmId : '',
      connectedAt: connected ? auth.connectedAt : null,
      refreshTokenExpiresAt: connected ? auth.refreshTokenExpiresAt : null,
      lastError: (auth && auth.lastError) || '',
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/quickbooks/connect — hand back the Intuit authorize URL to open.
const connect = async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(400).json({ message: 'QuickBooks is not configured. Set QBO_CLIENT_ID and QBO_CLIENT_SECRET on the backend.' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    let auth = await QuickbooksAuth.findOne();
    if (!auth) auth = new QuickbooksAuth();
    auth.pendingState = state;
    await auth.save();
    res.json({ url: buildAuthUrl(state) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/quickbooks/callback — Intuit redirects the browser here after consent
// with ?code&state&realmId. Public (a redirect carries no Bearer), gated by state.
const callback = async (req, res) => {
  const done = (msg, ok) => res.status(ok ? 200 : 400).send(
    `<html><body style="font-family:sans-serif;padding:40px;text-align:center;background:#0c1410;color:#f3f7f4">` +
    `<h2 style="color:${ok ? '#4ade80' : '#f87171'}">${ok ? 'QuickBooks connected ✓' : 'QuickBooks connection failed'}</h2>` +
    `<p style="color:#9fb3aa">${msg}</p>` +
    (ok ? `<script>setTimeout(function(){window.close()},2000)</script>` : '') +
    `</body></html>`);
  try {
    if (!isConfigured()) return done('QuickBooks is not configured on the backend.', false);
    const { code, state, realmId } = req.query;
    const auth = await QuickbooksAuth.findOne();
    if (!auth || !auth.pendingState || auth.pendingState !== state) {
      return done('Invalid or expired state — start the connection again from Studio.', false);
    }
    if (!code || !realmId) return done('Intuit didn’t return a code + company id — try connecting again.', false);
    const tok = await exchangeToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    applyToken(auth, tok);
    if (!auth.refreshToken) return done('QuickBooks did not return a refresh token — try connecting again.', false);
    auth.realmId = String(realmId);
    auth.companyName = await fetchCompanyName(auth.accessToken, auth.realmId);
    auth.pendingState = '';
    auth.connectedAt = new Date();
    auth.lastError = '';
    await auth.save();
    done(`Connected to ${auth.companyName || 'your company'}. You can close this window and return to Studio.`, true);
  } catch (e) {
    const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    done(detail, false);
  }
};

// POST /api/quickbooks/disconnect — revoke with Intuit (best-effort) + clear.
const disconnect = async (req, res) => {
  try {
    const auth = await QuickbooksAuth.findOne();
    if (auth && auth.refreshToken && isConfigured()) {
      try {
        await axios.post(REVOKE_URL, new URLSearchParams({ token: auth.refreshToken }).toString(), {
          headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
        });
      } catch (_) { /* revoke is best-effort — clear locally regardless */ }
    }
    await QuickbooksAuth.deleteMany({});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

module.exports = {
  status, connect, callback, disconnect,
  isConfigured, freshAccessToken, buildAuthUrl, applyToken,
  API_BASE, _SCOPE: SCOPE, _REDIRECT_URI: REDIRECT_URI,
};
