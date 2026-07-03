// services/senderPool.js
//
// Multi-identity sending pool — the FREE way to send more cold email per day.
// The daily cap is per sending IDENTITY (that's what protects reputation), so a
// second campaign just shares the same inbox's cap. To actually send more for
// $0, rotate across several free-tier ESP inboxes (Brevo 300/day, Mailjet
// 200/day, a Zoho/Gmail mailbox, …); the engine round-robins across them and
// each keeps its own daily sub-cap + warm-up. Total free volume = the sum.
//
// Config: OUTREACH_SENDERS = a JSON array of identities:
//   [{"label":"brevo","from":"nate@getjp.com","replyTo":"nate@jointprinting.com",
//     "host":"smtp-relay.brevo.com","port":587,"user":"...","pass":"...","dailyCap":250}]
// If it's unset, we fall back to the single legacy identity (OUTREACH_EMAIL_FROM
// + the global SMTP_* transport), so nothing changes until you opt in.
//
// parseSenders() is PURE (unit-tested); getSenders() reads env + caches.

function normalizeSender(s, i) {
  if (!s || !s.from) return null;
  const label = String(s.label || `s${i + 1}`).trim().slice(0, 24) || `s${i + 1}`;
  const port = parseInt(s.port || 587, 10);
  const hasOwnSmtp = s.host && s.user;
  return {
    label,
    from: String(s.from).trim(),
    replyTo: String(s.replyTo || '').trim(),
    dailyCap: Math.max(1, parseInt(s.dailyCap || 40, 10)),
    // Per-identity SMTP; null → the engine uses the global SMTP_* transport
    // (lets you run several from-addresses on one provider account).
    smtp: hasOwnSmtp ? { host: String(s.host), port: Number.isFinite(port) ? port : 587, user: String(s.user), pass: String(s.pass || '') } : null,
  };
}

// Build the identity list from the OUTREACH_SENDERS json, else the legacy single
// identity. PURE. Dedup labels so per-identity counters never collide.
function parseSenders(rawJson, legacy = {}) {
  let list = [];
  if (rawJson) {
    try {
      const arr = JSON.parse(rawJson);
      if (Array.isArray(arr)) list = arr;
    } catch { /* malformed → fall back to legacy */ }
  }
  const seen = new Set();
  const clean = [];
  list.forEach((s, i) => {
    const n = normalizeSender(s, i);
    if (!n) return;
    let label = n.label;
    let k = 2;
    while (seen.has(label)) label = `${n.label}-${k++}`;
    seen.add(label);
    clean.push({ ...n, label });
  });
  if (clean.length) return clean;

  // Legacy single-identity fallback.
  if (legacy.from) {
    const n = normalizeSender({
      label: 'primary', from: legacy.from, replyTo: legacy.replyTo,
      host: legacy.host, port: legacy.port, user: legacy.user, pass: legacy.pass,
      dailyCap: legacy.dailyCap,
    }, 0);
    return n ? [n] : [];
  }
  return [];
}

let _cache = { at: 0, val: null, key: '' };

// The live identity list from env (cached until the env string changes).
function getSenders() {
  const raw = process.env.OUTREACH_SENDERS || '';
  const legacy = {
    from: process.env.OUTREACH_EMAIL_FROM || '',
    replyTo: process.env.OUTREACH_REPLY_TO || '',
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT || '587',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    dailyCap: process.env.OUTREACH_DAILY_CAP || '50',
  };
  const key = `${raw}|${legacy.from}|${legacy.host}|${legacy.user}|${legacy.dailyCap}`;
  if (_cache.val && _cache.key === key) return _cache.val;
  const val = parseSenders(raw, legacy);
  _cache = { at: 0, val, key };
  return val;
}

module.exports = { parseSenders, normalizeSender, getSenders };
