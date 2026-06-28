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
    const k = normalizeOrderNumber(t.orderNumber);
    if (!k || keys.has(k)) continue;
    out.push({
      txnId: String(t._id), orderNumber: t.orderNumber || '', party: t.party || '',
      amount: Number(t.amount) || 0, category: t.category, date: t.date || null,
    });
  }
  return out;
}

module.exports = {
  deriveCompanyKey, normalizeOrderNumber, splitPollutedName,
  detectOrphanOrders, detectPollutedClients, detectMisKeyedReceipts, COST_CATEGORIES,
};
