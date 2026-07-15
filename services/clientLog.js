// services/clientLog.js
//
// Append a timestamped touch to a CRM client's timeline (Client.log[]) from
// anywhere in the ecosystem. The big cross-tool events — a quote/approval link
// sent, an order placed, delivered, paid — call this so the CRM card's activity
// reflects what actually HAPPENED, not just the owner's manual notes.
//
// Idempotent via dedupKey: an entry whose dedupKey is already on the client is
// skipped, so a milestone (e.g. "order #123 placed") logs once even if the
// triggering write runs again. Best-effort by contract — it never throws into the
// caller, so a logging hiccup can't fail the order/approval write that triggered it.

const Client = require('../models/Client');

async function appendClientLog(companyKey, { text, kind = 'system', dedupKey = '' } = {}) {
  try {
    const key = String(companyKey || '').trim();
    if (!key || !text) return false;
    if (dedupKey) {
      const exists = await Client.findOne({ companyKey: key, 'log.dedupKey': dedupKey }).select('_id').lean();
      if (exists) return false;
    }
    const r = await Client.updateOne(
      { companyKey: key },
      { $push: { log: { at: new Date(), text: String(text).slice(0, 300), kind, dedupKey } } },
    );
    return !!(r && (r.modifiedCount || r.nModified));
  } catch (e) {
    console.warn('[clientLog] append skipped:', e.message);
    return false;
  }
}

module.exports = { appendClientLog };
