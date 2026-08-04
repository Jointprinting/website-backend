// services/leadFit.js
//
// "Is this company a cold-outreach target at all?" — one home for the verdict,
// because it has to hold in TWO places and they must never disagree.
//
// The Field Map already knows things about a shop that the CRM record doesn't:
// whether it's a chain (corporate handles merch, not the store) and whether it
// sits in a real licensed retail market (a hemp/CBD shop or a smoke shop can't
// buy dispensary merch). Both live on the Dispensary collection, joined on the
// same `companyKey` spine.
//
// Enrollment screens on this. Send time did NOT — so every lead enrolled BEFORE
// the screen existed stayed in the sequence and kept getting mail. The owner
// watched "Your CBD Store" and "Kiss Glass" sitting in his send queue. A gate
// that only guards the door does nothing about who is already inside, and the
// irreversible act is the send, not the enrollment.
//
// Pure and dependency-light: callers pass in the Dispensary rows.

const { ROSTER_STATES } = require('./dispensaryStates');

// States with a licensed retail market we actually sell into.
const LEGAL_RETAIL_STATES = new Set(Object.keys(ROSTER_STATES));

/**
 * Collapse a company's Dispensary rows into an outreach verdict.
 * One shop can have several rows (roster + Google sweep + OSM), so:
 *   • chain-ness is a brand fact — ANY row flagging it wins
 *   • "real retail" is the generous read — ONE row in a licensed retail market
 *     with a non-hemp segment is enough to keep them
 * Returns { excluded: Map<companyKey, 'chain'|'non-retail'>, chains, nonRetail }.
 * Pure.
 */
function fieldMapExclusions(rows = [], { includeChains = false, includeNonRetail = false } = {}) {
  const byKey = new Map();
  for (const r of rows || []) {
    const key = r && String(r.companyKey || '').trim();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { chain: false, retail: false });
    const v = byKey.get(key);
    if (r.isChain) v.chain = true;
    if (LEGAL_RETAIL_STATES.has(String(r.state || '').toUpperCase()) && r.segment !== 'hemp') v.retail = true;
  }
  const excluded = new Map();
  let chains = 0;
  let nonRetail = 0;
  for (const [key, v] of byKey) {
    if (v.chain) { if (!includeChains) { excluded.set(key, 'chain'); chains += 1; } continue; }
    if (!v.retail && !includeNonRetail) { excluded.set(key, 'non-retail'); nonRetail += 1; }
  }
  return { excluded, chains, nonRetail };
}

/**
 * The send-time verdict for ONE company, given its Dispensary rows.
 * '' = send. Anything else is the reason to hold.
 *
 * Deliberately silent when we hold NO Field Map rows for the company: absence of
 * evidence is not evidence of a chain, and a lead sourced outside the map (a
 * referral, a hand-added prospect, a non-cannabis vertical) must not be blocked
 * by a map that never saw it. Pure.
 */
function sendFitReason(rows = [], opts = {}) {
  if (!rows || !rows.length) return '';
  const key = String((rows[0] && rows[0].companyKey) || '').trim();
  if (!key) return '';
  const { excluded } = fieldMapExclusions(rows, opts);
  return excluded.get(key) || '';
}

module.exports = { fieldMapExclusions, sendFitReason, LEGAL_RETAIL_STATES };
