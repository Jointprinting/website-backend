// services/upsTracking.js
//
// UPS auto-delivered: polls open orders whose client tracking timeline carries
// a UPS tracking link and flips them to 'delivered' the moment UPS reports the
// package delivered — the client's timeline updates instantly and the linked
// deal auto-wins through the same delivered→won rule the manual tick uses.
//
// Idle (never calls out) until UPS_CLIENT_ID / UPS_CLIENT_SECRET are set —
// same posture as the outreach engine's env gates. Token is OAuth client
// credentials against the production UPS API host (override with UPS_API_BASE
// for CIE testing).

const axios = require('axios');
const crypto = require('crypto');

const UPS_BASE = process.env.UPS_API_BASE || 'https://onlinetools.ups.com';
const TICK_MS = 60 * 60 * 1000;          // hourly — deliveries don't need minute precision
const FIRST_TICK_MS = 2 * 60 * 1000;     // first pass shortly after boot
const MAX_LOOKUPS_PER_TICK = 50;         // stay far under UPS rate limits

// UPS "1Z" tracking numbers as they appear inside carrier URLs or pasted raw.
const UPS_NUM_RE = /1Z[0-9A-Z]{16}/i;

// Steps that represent the FINAL client-facing leg. A "Blanks shipping" link
// must never auto-deliver the whole order, so a number only counts when its
// step reads like final delivery — or the order is already 'shipped' (at that
// point the last linked step IS the client leg).
const FINAL_LEG_RE = /deliver|on\s*the\s*way|to\s*you|out\s*for/i;

function upsConfigured() {
  return !!(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET);
}

// ── OAuth (client credentials), cached until shortly before expiry ───────────
let tokenCache = { token: '', exp: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const basic = Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64');
  const r = await axios.post(
    `${UPS_BASE}/security/v1/oauth/token`,
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 },
  );
  const ttl = parseInt(r.data && r.data.expires_in, 10) || 3600;
  tokenCache = { token: r.data.access_token, exp: Date.now() + ttl * 1000 };
  return tokenCache.token;
}

// ── One tracking lookup ───────────────────────────────────────────────────────
// Returns { delivered, deliveredAt, statusText }. UPS marks a delivered
// activity with status.type 'D'; activity date/time come as YYYYMMDD/HHMMSS.
async function trackOne(num) {
  const token = await getToken();
  const r = await axios.get(`${UPS_BASE}/api/track/v1/details/${encodeURIComponent(num)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      transId: crypto.randomUUID(),
      transactionSrc: 'jp-studio',
    },
    timeout: 15000,
  });
  const shipments = (r.data && r.data.trackResponse && r.data.trackResponse.shipment) || [];
  let delivered = false, deliveredAt = null, statusText = '';
  for (const sh of shipments) {
    for (const pkg of sh.package || []) {
      for (const act of pkg.activity || []) {
        const st = act.status || {};
        if (!statusText) statusText = st.description || '';
        if (String(st.type).toUpperCase() === 'D') {
          delivered = true;
          const d = String((act.date || '')).trim();   // YYYYMMDD
          const t = String((act.time || '000000')).trim(); // HHMMSS
          if (/^\d{8}$/.test(d)) {
            deliveredAt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2) || '00'}:${t.slice(2, 4) || '00'}:${t.slice(4, 6) || '00'}Z`);
          }
          statusText = st.description || 'Delivered';
        }
      }
    }
  }
  return { delivered, deliveredAt: deliveredAt || (delivered ? new Date() : null), statusText };
}

// ── Candidate extraction ──────────────────────────────────────────────────────
// The client-facing final leg: the LAST non-hidden timeline step carrying a UPS
// number — counted only when the step reads like final delivery, or the order
// is already 'shipped'.
function finalLegFor(order) {
  const steps = (order.tracking && order.tracking.steps) || [];
  let found = null;
  for (const s of steps) {
    if (s.hidden) continue;
    const m = String(s.link || '').match(UPS_NUM_RE);
    if (m) found = { step: s, num: m[0].toUpperCase() };
  }
  if (!found) return null;
  const finalish = FINAL_LEG_RE.test(String(found.step.label || '')) || FINAL_LEG_RE.test(String(found.step.id || ''));
  if (order.status === 'shipped' || finalish) return found;
  return null;
}

// ── Mark delivered (same effects as the manual delivered tick) ───────────────
async function markDelivered(order, leg, deliveredAt) {
  const Deal = require('../models/Deal');
  order.status = 'delivered';
  if (!order.deliveredDate) order.deliveredDate = deliveredAt;
  leg.step.completedAt = leg.step.completedAt || deliveredAt;
  if (!leg.step.note) leg.step.note = 'Delivered — confirmed by UPS';
  await order.save();

  // Delivered → deal won, mirroring the updateOrder hook (owner's rule: a deal
  // is won only when its order is delivered). Best-effort.
  try {
    const or = [{ sourceOrderId: order._id }];
    if (order.projectNumber) or.push({ projectNumber: order.projectNumber });
    if (order.orderNumber) or.push({ orderNumber: order.orderNumber });
    const r = await Deal.updateMany(
      { $or: or, stage: { $nin: ['won', 'lost'] } },
      { $set: { stage: 'won', wonAt: new Date() } },
    );
    if (r.modifiedCount) console.log(`[ups] order ${order.orderNumber || order.projectNumber} delivered → ${r.modifiedCount} deal(s) won`);
  } catch (e) {
    console.warn('[ups] delivered→won sync failed:', e.message);
  }
}

// ── The tick ──────────────────────────────────────────────────────────────────
// Returns a per-order report so the Studio's "check UPS now" button can show
// exactly what happened (also handy for the first live test).
async function runUpsTick() {
  if (!upsConfigured()) return { configured: false, checked: 0, delivered: 0, results: [] };
  const Order = require('../models/Order');
  const orders = await Order.find({
    archived: { $ne: true },
    status: { $in: ['placed', 'in_production', 'shipped'] },
    'tracking.steps.link': { $regex: UPS_NUM_RE },
  }).limit(200);

  const results = [];
  let lookups = 0, deliveredCount = 0;
  const seen = new Map(); // tracking number → result (a shared truck shares one lookup)
  for (const order of orders) {
    const leg = finalLegFor(order);
    if (!leg) continue;
    if (lookups >= MAX_LOOKUPS_PER_TICK) { results.push({ order: order.orderNumber || order.projectNumber, skipped: 'rate-cap' }); continue; }
    try {
      let track = seen.get(leg.num);
      if (!track) { lookups += 1; track = await trackOne(leg.num); seen.set(leg.num, track); }
      if (track.delivered) {
        await markDelivered(order, leg, track.deliveredAt);
        deliveredCount += 1;
      }
      results.push({
        order: order.orderNumber || order.projectNumber || String(order._id),
        company: order.companyName || '',
        trackingNumber: leg.num,
        status: track.delivered ? 'DELIVERED' : (track.statusText || 'in transit'),
        delivered: track.delivered,
      });
    } catch (e) {
      const code = e.response && e.response.status;
      results.push({ order: order.orderNumber || order.projectNumber || String(order._id), trackingNumber: leg.num, error: code ? `UPS ${code}` : e.message });
    }
  }
  if (deliveredCount) console.log(`[ups] tick: ${lookups} lookups, ${deliveredCount} order(s) auto-delivered`);
  return { configured: true, checked: results.length, delivered: deliveredCount, results };
}

let started = false;
function startUpsTracking() {
  if (started) return;
  started = true;
  if (!upsConfigured()) {
    console.log('[ups] idle — set UPS_CLIENT_ID / UPS_CLIENT_SECRET to enable auto-delivered');
  }
  // Config is re-checked every tick, so adding the env vars + redeploy is all
  // it takes — no code change to turn it on.
  setTimeout(() => { runUpsTick().catch((e) => console.warn('[ups] tick failed:', e.message)); }, FIRST_TICK_MS);
  setInterval(() => { runUpsTick().catch((e) => console.warn('[ups] tick failed:', e.message)); }, TICK_MS);
}

module.exports = { startUpsTracking, runUpsTick, upsConfigured, finalLegFor, trackOne, UPS_NUM_RE };
