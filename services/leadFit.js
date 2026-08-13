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

// ── What the business IS, read from its own name ─────────────────────────────
//
// `segment` looks like it answers this. It does not. deriveSegment() reads the
// STATE and nothing else: in a rec state every row is stamped 'rec' — a Google
// pin, an OSM node, a licensed storefront, all identical. So a CBD store or a
// smoke shop found by a sweep in Michigan is, to every query downstream,
// indistinguishable from a licensed dispensary. That is how "Harmony Hemp
// Farmacy", "Your CBD Haven" and "Mary Jane's CBD Dispensary - Smoke & Vape
// Shop" reached a send queue that is supposed to hold dispensaries only.
//
// Worse, geography can't speak at all for a lead the map never saw: OSM
// discovery creates CRM leads without writing Dispensary rows, and the gate is
// deliberately silent with no rows — which is how a Tennessee hemp shop got
// mail from a market with no licensed dispensaries in it.
//
// The name is the one signal we always hold, and these shops announce
// themselves in it. Word-boundary matched, never substrings: "Chempion" is not
// hemp and "Glasgow Cannabis Co" is not a glass shop.
//
// The trade is the same one the never-send domains make: skipping a real buyer
// costs one lead; sending costs a bounce that degrades delivery for every other
// lead we have, on a pitch that was never going to land. `includeNonRetail`
// turns the whole screen off for anyone who wants to work these anyway.
const NON_RETAIL_NAME_RULES = [
  // Hemp / CBD retail — federally-legal storefronts, not licensed dispensaries.
  { reason: 'hemp-cbd', re: /\b(hemp|cbd|cannabidiol|thca|delta[\s.-]?[89]|d8|kratom|kava)\b/i },
  // Smoke / vape / head shops — they sell glass, not branded dispensary merch.
  { reason: 'smoke-shop', re: /\b(vape|vapes|vaping|vapor|vapour|hookah|shisha|tobacco|cigars?|cigarettes?|glass|smokeshop)\b|\bhead\s*shop\b|\bsmoke\s*(?:&|and|\+|\/|-)?\s*(?:shop|vape)/i },
];

/**
 * Why this company can't be a cold-outreach target, judged only by its name.
 * '' = the name says nothing against it. Pure.
 */
function nonRetailNameReason(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  for (const rule of NON_RETAIL_NAME_RULES) if (rule.re.test(n)) return rule.reason;
  return '';
}

/**
 * The same rules as a Mongo clause, so sourcing queries never RETURN these rows
 * in the first place. Filtering them out in JS after the fetch would leave them
 * permanently unstamped at the head of the frontier, re-picked by every sweep —
 * the exact treadmill the attempt-stamping was built to end. Pure.
 */
function nonRetailNameFilter(field = 'name') {
  return { $nor: NON_RETAIL_NAME_RULES.map((r) => ({ [field]: r.re })) };
}

/**
 * Collapse a company's Dispensary rows into an outreach verdict.
 * One shop can have several rows (roster + Google sweep + OSM), so:
 *   • chain-ness is a brand fact — ANY row flagging it wins
 *   • a non-retail NAME is a brand fact too — ANY row naming it wins, and it
 *     outranks geography, because `segment` is only ever a guess from the state
 *   • "real retail" is the generous read — ONE row in a licensed retail market
 *     with a non-hemp segment is enough to keep them
 * Returns { excluded: Map<companyKey, reason>, chains, nonRetail, notRetailBusiness }.
 * Pure.
 */
function fieldMapExclusions(rows = [], { includeChains = false, includeNonRetail = false } = {}) {
  const byKey = new Map();
  for (const r of rows || []) {
    const key = r && String(r.companyKey || '').trim();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { chain: false, retail: false, byName: '' });
    const v = byKey.get(key);
    if (r.isChain) v.chain = true;
    if (!v.byName) v.byName = nonRetailNameReason(r.name);
    if (LEGAL_RETAIL_STATES.has(String(r.state || '').toUpperCase()) && r.segment !== 'hemp') v.retail = true;
  }
  const excluded = new Map();
  let chains = 0;
  let nonRetail = 0;
  let notRetailBusiness = 0;
  for (const [key, v] of byKey) {
    if (v.chain) { if (!includeChains) { excluded.set(key, 'chain'); chains += 1; } continue; }
    if (v.byName && !includeNonRetail) { excluded.set(key, v.byName); notRetailBusiness += 1; continue; }
    if (!v.retail && !includeNonRetail) { excluded.set(key, 'non-retail'); nonRetail += 1; }
  }
  return { excluded, chains, nonRetail, notRetailBusiness };
}

/**
 * The send-time verdict for ONE company, given its Dispensary rows.
 * '' = send. Anything else is the reason to hold.
 *
 * Deliberately silent when we hold NO Field Map rows for the company: absence of
 * evidence is not evidence of a chain, and a lead sourced outside the map (a
 * referral, a hand-added prospect, a non-cannabis vertical) must not be blocked
 * by a map that never saw it.
 *
 * The NAME, though, is read first and needs no rows at all — a lead whose own
 * name says "CBD" or "Smoke & Vape" is not a licensed dispensary whether or not
 * the map ever saw it, and that is precisely the population the row-joined gate
 * could never reach. Pass `opts.name` (the enrollment's companyName). Pure.
 */
function sendFitReason(rows = [], opts = {}) {
  if (!opts.includeNonRetail) {
    const byName = nonRetailNameReason(opts.name);
    if (byName) return byName;
  }
  if (!rows || !rows.length) return '';
  const key = String((rows[0] && rows[0].companyKey) || '').trim();
  if (!key) return '';
  const { excluded } = fieldMapExclusions(rows, opts);
  return excluded.get(key) || '';
}

module.exports = {
  fieldMapExclusions, sendFitReason, LEGAL_RETAIL_STATES,
  nonRetailNameReason, nonRetailNameFilter, NON_RETAIL_NAME_RULES,
};
