// services/dataCleanup.js
//
// Pure detection + planning for the owner-run "Fix data" cleanup tool. No DB: the
// controller loads the live Orders / Clients / Transactions, runs these, and (only
// on an explicit confirm) applies the field-level fixes with a reversible snapshot.
//
// It surfaces ONLY genuine problems — it never asks the owner to re-enter history.
// Three conservative detections:
//   1. orphaned orders        — a real order with a name but NO companyKey (so it
//                               can't link to a client / count toward customers).
//   2. contact-polluted names — companyName has the contact baked in
//                               ("Nathan Vigil, Happy Leaf Dispensary").
//   3. mis-keyed cost receipts — an expense whose order # matches no real order
//                               (a typo'd receipt, e.g. blanks booked under #73938537).
//
// The fixes are deliberately field-level + reversible. Consolidating an actual
// DUPLICATE company stays with the existing, tested "Clean up → Duplicates" merge
// (companyKey is unique, so this tool never re-keys a record into a collision).

// companyKey derivation — MUST match models/Order.js deriveCompanyKey (lowercased,
// alphanumerics only). Replicated here so the service stays pure (no model import).
const deriveCompanyKey = (companyName, clientName) =>
  String(companyName || clientName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Canonical order number — MUST match controllers/finances.js normalizeOrderNumber
// (digits only, leading zeros stripped) so a receipt's "#0001050" lines up with order "1050".
const normalizeOrderNumber = (v) =>
  String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');

// Loose name compare (case/punctuation-insensitive) for the contact-match gate.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// COGS categories that represent a real COST receipt — mirrors Transaction.COGS_CATEGORIES.
const COST_CATEGORIES = new Set(['Blank COGS', 'Printer COGS', 'Shipping', 'Art', 'Commission', 'Processing Fee']);

// A "mis-keyed receipt" only makes sense for a row the owner HAND-ENTERED. The bulk
// budget-import / restart rows (source 'budget'/'import') and system-generated rows
// ('order:auto'/'fee:auto'/'merge') sit on his historical manual order #s by design and
// are NEVER worth chasing — "ignore them; only future ones matter." Mirrors
// services/financeDedupe.js MANUAL_SOURCES; a missing source defaults to a hand entry.
const MANUAL_RECEIPT_SOURCES = new Set(['manual', 'receipt', '']);

// 1) Orders with a real company/contact name but no companyKey → derive the key so
//    they link to their client (and the client counts as a real customer).
function detectOrphanOrders(orders) {
  const out = [];
  for (const o of (orders || [])) {
    if (!o) continue;
    const hasName = String(o.companyName || '').trim() || String(o.clientName || '').trim();
    const key = String(o.companyKey || '').trim();
    if (!hasName || key) continue;
    const derived = deriveCompanyKey(o.companyName, o.clientName);
    if (!derived) continue;
    out.push({
      orderId: String(o._id), orderNumber: o.orderNumber || '',
      companyName: o.companyName || '', clientName: o.clientName || '', derivedKey: derived,
    });
  }
  return out;
}

// Split "Contact, Company" → { contact, company }, but ONLY when the left segment IS
// the record's stored contact name. That high-confidence gate avoids mangling a legit
// company name that happens to contain a comma ("Smith, Jones & Co").
function splitPollutedName(companyName, clientName) {
  const cn = String(companyName || '');
  const ci = cn.indexOf(',');
  if (ci < 0) return null;
  const left = cn.slice(0, ci).trim();
  const right = cn.slice(ci + 1).trim();
  if (!left || !right) return null;
  if (!clientName || norm(left) !== norm(clientName)) return null;   // confidence gate
  return { contact: left, company: right };
}

// 2) Clients whose companyName has the contact baked in.
function detectPollutedClients(clients) {
  const out = [];
  for (const c of (clients || [])) {
    if (!c || c.archived) continue;
    const split = splitPollutedName(c.companyName, c.clientName);
    if (!split) continue;
    out.push({
      clientId: String(c._id), companyKey: c.companyKey || '',
      companyName: c.companyName || '', clientName: c.clientName || '',
      cleanCompany: split.company, contact: split.contact,
    });
  }
  return out;
}

// 3) Expense COGS receipts whose order # matches no real order. `orderKeys` is the
//    Set of canonical order numbers that DO exist.
function detectMisKeyedReceipts(transactions, orderKeys) {
  const keys = orderKeys instanceof Set ? orderKeys : new Set(orderKeys || []);
  const out = [];
  for (const t of (transactions || [])) {
    if (!t || t.type !== 'expense' || !COST_CATEGORIES.has(t.category)) continue;
    // Skip the historical budget-import / system rows — only a hand-entered receipt can
    // be "mis-keyed" worth fixing. (A missing source is a legacy hand entry → kept.)
    const src = t.source == null ? 'manual' : String(t.source);
    if (!MANUAL_RECEIPT_SOURCES.has(src)) continue;
    const k = normalizeOrderNumber(t.orderNumber);
    if (!k || keys.has(k)) continue;
    out.push({
      txnId: String(t._id), orderNumber: t.orderNumber || '', party: t.party || '',
      amount: Number(t.amount) || 0, category: t.category, date: t.date || null,
    });
  }
  return out;
}

// ── 4) Duplicate SALES — the same real sale booked twice ─────────────────────
// The Happy-Leaf class: one real order's income gets re-entered a SECOND time under
// a contact-polluted name ("Nathan Vigil, Happy Leaf Dispensary") and/or the owner's
// unreliable manual budget order #, so the by-client view forks one company into two
// rows AND the headline revenue/profit is inflated by the doubled amount. by-client
// rolls up by the free-text payment party, so a name variant is enough to split it.
//
// This is the income analogue of detectMisKeyedReceipts, but with a much TIGHTER gate
// because the fix is destructive (it removes a revenue row). The EXACT Happy-Leaf
// signature requires BOTH halves — either alone is a NORMAL data shape, not a duplicate:
//   • the row sits on an ORPHAN order # (matches no real order); AND
//   • the row's party is CONTACT-POLLUTED — "Contact, Company" — and its Company half
//     IS the company of a DIFFERENT, REAL-order-backed same-amount sale within the
//     window (that real sale is the keeper it re-entered).
// Why both are required:
//   • Orphan # alone is the owner's NORMAL state for a manually-booked sale (his budget
//     #s match no Order) — a bare-name sale on a budget # that merely shares an amount
//     with a real order is a genuine second sale, NOT a duplicate.
//   • Contact-pollution alone is the owner's NORMAL way of typing a customer ("Contact,
//     Company") — a polluted name on its OWN real order # is just a name to clean
//     (detectPollutedClients), never a duplicate.
//   • TOGETHER — a contact-polluted re-entry under a budget # that duplicates a real,
//     bare-name sale — is the precise thing that happened to Happy Leaf, and is very
//     unlikely to be a coincidence.
// Customer REFUND credits (isCredit) are excluded outright (a credit nets revenue DOWN;
// deleting it would INFLATE revenue). The owner still confirms each pair in the preview.

// The candidate company keys a payment party resolves to: the whole-name key, plus —
// when the party is "Contact, Company" — the company-half key. Two parties belong to
// the same company when these sets intersect (so "Nathan Vigil, Happy Leaf Dispensary"
// ≡ "Happy Leaf Dispensary" via the shared 'happyleafdispensary').
function partyCompanyKeys(party) {
  const full = deriveCompanyKey(party, '');
  const p = String(party || '');
  const ci = p.indexOf(',');
  let right = null;
  if (ci >= 0) {
    const rk = deriveCompanyKey(p.slice(ci + 1).trim(), '');
    if (rk) right = rk;
  }
  return { full, right };
}
// The canonical company key for a party — the company half when contact-polluted, else
// the whole name. This is the key the surviving (keeper) row deep-links by.
function companyKeyOf(cks) { return (cks && cks.right) || (cks && cks.full) || ''; }
// Whole-day distance gate. This is the only TEMPORAL guard on a destructive removal, so
// a missing/unparseable date FAILS the window (never "within") — the safe direction,
// matching services/financeDedupe.js daysApart. Two parseable dates must fall inside the
// window so two same-priced sales months apart can't collide.
function withinDays(a, b, win) {
  const da = a ? new Date(a).getTime() : NaN;
  const db = b ? new Date(b).getTime() : NaN;
  if (isNaN(da) || isNaN(db)) return false;
  return Math.abs(da - db) <= win * 86400000;
}

// `incomeRows` = Customer-Sales income transactions; `orderKeys` = Set of canonical
// order numbers that DO exist. Returns one entry per flagged DUPLICATE row, each
// carrying the keeper it duplicates (for the side-by-side preview) and the canonical
// companyKey the keeper links by.
function detectDuplicateSales(incomeRows, orderKeys, opts = {}) {
  // 45 days: wide enough for the owner's budget-vs-manual entry drift of the SAME sale
  // (~2 weeks), narrow enough that a genuine repeat order months later doesn't collide.
  // The owner is still the final gate — each flagged pair is confirmed individually.
  const windowDays = opts.windowDays != null ? opts.windowDays : 45;
  const keys = orderKeys instanceof Set ? orderKeys : new Set(orderKeys || []);
  const ann = (incomeRows || [])
    // Real, positive Customer-Sales revenue only — a refund credit (isCredit) is contra
    // revenue and must NEVER be treated as, or archived as, a duplicate sale.
    .filter((t) => t && t.type === 'income' && t.category === 'Client Sales' && !t.isCredit)
    .map((r) => {
      const ok = normalizeOrderNumber(r.orderNumber);
      const cks = partyCompanyKeys(r.party);
      return { r, ok, isReal: !!ok && keys.has(ok), cks };
    });

  // Bucket by amount-to-the-cent — only equal-amount rows can ever be a duplicate.
  const byAmt = new Map();
  for (const a of ann) {
    const cents = Math.round((Number(a.r.amount) || 0) * 100);
    if (!Number.isFinite(cents) || cents <= 0) continue;
    if (!byAmt.has(cents)) byAmt.set(cents, []);
    byAmt.get(cents).push(a);
  }

  const seen = new Set();
  const out = [];
  for (const group of byAmt.values()) {
    if (group.length < 2) continue;
    for (const dup of group) {
      if (seen.has(String(dup.r._id))) continue;
      // (1) The dup must sit on an ORPHAN order # — a row anchored to a real order is,
      //     by definition, a real sale, never archived here.
      if (dup.isReal) continue;
      // (2) The dup's party must be CONTACT-POLLUTED ("Contact, Company"). A BARE-name
      //     sale on a budget # is the owner's normal genuine sale — never a duplicate.
      if (dup.cks.right == null) continue;
      // A keeper: a DIFFERENT, REAL-order-backed sale whose company IS the dup's company
      //     half ("Happy Leaf Dispensary"), within the date window. (A keeper is
      //     real-order-backed, so it can never itself be flagged as a dup — no mutual
      //     archiving — and the company-half match is what ties the re-entry to it.)
      const keeper = group.find((k) =>
        k !== dup && k.isReal && k.ok && k.ok !== dup.ok
        && companyKeyOf(k.cks) === dup.cks.right
        && withinDays(k.r.date, dup.r.date, windowDays));
      if (!keeper) continue;
      seen.add(String(dup.r._id));
      out.push({
        txnId: String(dup.r._id),
        orderNumber: dup.r.orderNumber || '',
        party: dup.r.party || '',
        amount: Number(dup.r.amount) || 0,
        date: dup.r.date || null,
        reason: 'contact-polluted-orphan',
        orphanOrder: true,
        companyKey: companyKeyOf(keeper.cks),
        keeper: {
          txnId: String(keeper.r._id),
          orderNumber: keeper.r.orderNumber || '',
          party: keeper.r.party || '',
          amount: Number(keeper.r.amount) || 0,
          date: keeper.r.date || null,
        },
      });
    }
  }
  return out;
}

module.exports = {
  deriveCompanyKey, normalizeOrderNumber, splitPollutedName,
  detectOrphanOrders, detectPollutedClients, detectMisKeyedReceipts, detectDuplicateSales,
  partyCompanyKeys, companyKeyOf, COST_CATEGORIES,
};
