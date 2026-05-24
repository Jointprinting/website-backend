// controllers/quickbooks.js
//
// QuickBooks Online integration. The user invoices + collects payment in QBO;
// this connects the account (OAuth2) and syncs invoice payment status back so
// an Order auto-flips paid=true once its QuickBooks invoice is fully paid.
//
// Matching key: QBO Invoice.DocNumber  ==  Order.orderNumber  (both = invoice #).
//
// Required backend env vars (set these on Render):
//   QBO_CLIENT_ID      — from the Intuit developer app
//   QBO_CLIENT_SECRET  — from the Intuit developer app
//   QBO_REDIRECT_URI   — must exactly match a Redirect URI on the Intuit app,
//                        e.g. https://jointprinting-backend.onrender.com/api/quickbooks/callback
//   QBO_ENVIRONMENT    — 'production' (default) or 'sandbox'
//
// Until those are set every endpoint reports configured:false and stays inert.

const axios  = require('axios');
const crypto = require('crypto');
const QuickBooksAuth = require('../models/QuickBooksAuth');
const Order = require('../models/Order');

const CLIENT_ID     = process.env.QBO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.QBO_REDIRECT_URI || '';
const ENVIRONMENT   = (process.env.QBO_ENVIRONMENT || 'production').toLowerCase();

const AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE  = ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';
const SCOPE = 'com.intuit.quickbooks.accounting';

const isConfigured = () => !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
const basicAuth    = () => 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

async function exchangeToken(params) {
  const r = await axios.post(TOKEN_URL, new URLSearchParams(params).toString(), {
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });
  return r.data; // { access_token, refresh_token, expires_in, x_refresh_token_expires_in }
}

function applyToken(auth, tok) {
  auth.accessToken           = tok.access_token;
  auth.refreshToken          = tok.refresh_token || auth.refreshToken;
  auth.accessTokenExpiresAt  = new Date(Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  auth.refreshTokenExpiresAt = new Date(Date.now() + (Number(tok.x_refresh_token_expires_in) || 8640000) * 1000);
}

// Return a valid access token, refreshing it first if it's within 60s of expiry.
async function freshAccessToken(auth) {
  const ok = auth.accessToken && auth.accessTokenExpiresAt &&
    auth.accessTokenExpiresAt.getTime() - Date.now() > 60000;
  if (ok) return auth.accessToken;
  const tok = await exchangeToken({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
  applyToken(auth, tok);
  await auth.save();
  return auth.accessToken;
}

// GET /api/quickbooks/status
const status = async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.json({ configured: false, connected: false, environment: ENVIRONMENT });
    }
    const auth = await QuickBooksAuth.findOne();
    res.json({
      configured:  true,
      connected:   !!(auth && auth.accessToken && auth.realmId),
      realmId:     auth ? auth.realmId : '',
      connectedAt: auth ? auth.connectedAt : null,
      lastSyncAt:  auth ? auth.lastSyncAt : null,
      environment: ENVIRONMENT,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/quickbooks/connect — hands back the Intuit authorize URL to open.
const connect = async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(400).json({ message: 'QuickBooks is not configured. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI on the backend.' });
    }
    const state = crypto.randomBytes(16).toString('hex');
    let auth = await QuickBooksAuth.findOne();
    if (!auth) auth = new QuickBooksAuth();
    auth.pendingState = state;
    await auth.save();
    const url = `${AUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
    res.json({ url });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/quickbooks/callback — Intuit redirects the browser here after the
// user authorizes. Public (no Bearer token on a redirect) but gated by the
// random `state` value minted in /connect.
const callback = async (req, res) => {
  const done = (msg, ok) => res.status(ok ? 200 : 400).send(
    `<html><body style="font-family:sans-serif;padding:40px;text-align:center">` +
    `<h2>${ok ? 'QuickBooks connected ✓' : 'QuickBooks connection failed'}</h2>` +
    `<p>${msg}</p>` +
    (ok ? `<script>setTimeout(function(){window.close()},1800)</script>` : '') +
    `</body></html>`);
  try {
    if (!isConfigured()) return done('QuickBooks is not configured on the backend.', false);
    const { code, state, realmId } = req.query;
    const auth = await QuickBooksAuth.findOne();
    if (!auth || !auth.pendingState || auth.pendingState !== state) {
      return done('Invalid or expired state — start the connection again from Studio.', false);
    }
    const tok = await exchangeToken({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
    });
    applyToken(auth, tok);
    auth.realmId      = realmId || auth.realmId;
    auth.pendingState = '';
    auth.connectedAt  = new Date();
    await auth.save();
    done('You can close this window and return to Studio.', true);
  } catch (e) {
    const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    done(detail, false);
  }
};

// POST /api/quickbooks/disconnect
const disconnect = async (req, res) => {
  try {
    await QuickBooksAuth.deleteMany({});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// POST /api/quickbooks/sync — pull invoices from QBO and mark the matching
// Order paid when its invoice is fully paid (Balance 0). Only ever flips paid
// to true — never un-marks — so a QBO hiccup can't wipe a manual paid flag.
const sync = async (req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ message: 'QuickBooks is not configured.' });
    const auth = await QuickBooksAuth.findOne();
    if (!auth || !auth.accessToken || !auth.realmId) {
      return res.status(400).json({ message: 'QuickBooks is not connected. Connect it first.' });
    }
    const accessToken = await freshAccessToken(auth);

    const query = 'select Id, DocNumber, TotalAmt, Balance from Invoice maxresults 1000';
    const r = await axios.get(`${API_BASE}/v3/company/${auth.realmId}/query`, {
      params:  { query, minorversion: 70 },
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const invoices = (r.data && r.data.QueryResponse && r.data.QueryResponse.Invoice) || [];

    let matched = 0, markedPaid = 0, markedProcessing = 0;
    const details = [];
    for (const inv of invoices) {
      const docNum = String(inv.DocNumber || '').trim();
      if (!docNum) continue;
      const order = await Order.findOne({ orderNumber: docNum });
      if (!order) continue;
      matched++;

      const total = Number(inv.TotalAmt) || 0;
      const bal   = Number(inv.Balance);
      const fullyPaid = bal === 0 && total > 0;
      const hasOpenBalance = total > 0 && bal > 0 && bal <= total;

      let saved = false;
      if (fullyPaid && !order.paid) {
        order.paid = true;
        order.paymentInProgress = false;
        order.activity = order.activity || [];
        order.activity.push({
          kind: 'paid_changed', actor: 'system',
          message: `Marked paid — QuickBooks invoice #${docNum} fully paid`,
          meta: { source: 'quickbooks', invoiceId: inv.Id }, at: new Date(),
        });
        markedPaid++;
        details.push({ orderNumber: docNum, projectNumber: order.projectNumber, status: 'paid' });
        saved = true;
      } else if (hasOpenBalance && !order.paid && !order.paymentInProgress) {
        // Invoice exists with an outstanding balance — payment is in progress
        // (or invoice is sent, not paid). Don't touch the paid flag.
        order.paymentInProgress = true;
        order.activity = order.activity || [];
        order.activity.push({
          kind: 'paid_changed', actor: 'system',
          message: `Payment in progress — QuickBooks invoice #${docNum} has an open balance of $${bal.toFixed(2)}`,
          meta: { source: 'quickbooks', invoiceId: inv.Id, balance: bal, total }, at: new Date(),
        });
        markedProcessing++;
        details.push({ orderNumber: docNum, projectNumber: order.projectNumber, status: 'processing' });
        saved = true;
      } else if (fullyPaid && order.paymentInProgress) {
        // Tidy-up: it was marked processing and is now fully paid.
        order.paymentInProgress = false;
        saved = true;
      }
      if (saved) await order.save();
    }
    auth.lastSyncAt = new Date();
    await auth.save();
    res.json({ invoicesChecked: invoices.length, matched, markedPaid, markedProcessing, details });
  } catch (e) {
    const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    res.status(500).json({ message: detail });
  }
};

module.exports = { status, connect, callback, disconnect, sync };
