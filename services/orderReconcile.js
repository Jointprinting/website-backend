// services/orderReconcile.js
//
// Pure logic for the owner-triggered "reconcile an order's scattered numbers" flow.
// A single real order sometimes ends up referenced by SEVERAL different numbers — the
// owner's budget sequence (#141), an invoice # (#1052), a project/order # the app shows
// (#1050/#138) — because the budget numbers are a manual sequence and never matched the
// system's. This finds every ledger row and order doc that points at one of those
// numbers (or carries the client's name on a non-canonical number) and folds them ALL
// onto ONE canonical number, so the finances/order views finally show a single order.
//
// PURE + table-driven (no DB here): the controller loads the live Transactions + Orders,
// calls buildReconcilePlan, shows the owner EXACTLY what would change (preview), and only
// on an explicit confirm renumbers them — reversibly (OrderRenumberBatch records the
// prior number of every touched record). Auto-hides when there's nothing left to fold
// (the plan comes back empty once everything reads the canonical number).
//
// SAFETY: every match is shown in the preview before anything is written, so an alias
// that turns out to belong to a DIFFERENT order is caught by the owner's eye (and the
// whole run is reversible regardless). A target order ALREADY on the canonical number is
// never touched.

// Canonical order key: digits only, leading zeros stripped — so "#0000141", "141" and
// "PO-141" are the SAME order. Mirrors controllers/finances.normalizeOrderNumber so the
// reconcile keys line up exactly with every finance view.
const normalizeOrderNumber = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');
const deriveCompanyKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// The reconcile targets. Each is ONE real order whose references are scattered. Curated
// (not guessed) so a renumber can never run wild: only the listed alias numbers — and
// rows carrying the client's own name — are ever folded, and only onto `canonical`
// (falling back to `fallback` if `canonical` is already a DIFFERENT client's order).
const TARGETS = [
  {
    key: 'happyleaf',
    label: 'Happy Leaf Dispensary',
    canonical: '138',
    fallback: '141',
    partyRe: /happy\s*leaf/i,
    // Every number this one order has been seen under (order #s AND invoice #s).
    aliasNumbers: ['141', '1050', '1052'],
  },
];

function getTarget(key) {
  return TARGETS.find((t) => t.key === key) || null;
}

// Does this record belong to the target's client (by name or stored companyKey)?
function recordIsClient(target, rec) {
  const name = String(rec.companyName || rec.clientName || rec.party || '');
  if (target.partyRe.test(name)) return true;
  if (rec.companyKey && rec.companyKey === target.key) return true;
  return deriveCompanyKey(name) === target.key;
}

// Build the renumber plan for ONE target from the live ledger + order docs. Returns the
// canonical number to use (after the "taken?" check), and the exact list of records to
// renumber with display fields so the preview can show each one. No writes.
function planForTarget(target, transactions, orders) {
  const aliasNorm = new Set((target.aliasNumbers || []).map(normalizeOrderNumber).filter(Boolean));
  let canonical = normalizeOrderNumber(target.canonical);

  // Is the canonical number already a DIFFERENT client's order? If so, claiming it would
  // collide two real orders — fall back to the secondary number instead.
  const ordersArr = (orders || []).filter(Boolean);
  const canonicalTakenByOther = ordersArr.some(
    (o) => !o.archived && normalizeOrderNumber(o.orderNumber) === canonical && !recordIsClient(target, o),
  );
  if (canonicalTakenByOther) canonical = normalizeOrderNumber(target.fallback);

  const changes = [];

  // Ledger transactions: match by alias order/invoice #, or by the client's name on a
  // non-canonical, non-blank number. Skip rows already on the canonical number.
  for (const t of (transactions || [])) {
    if (!t || t._id == null) continue;
    const onum = normalizeOrderNumber(t.orderNumber);
    if (onum === canonical) continue;
    const inum = normalizeOrderNumber(t.invoiceNumber);
    const byAlias = aliasNorm.has(onum) || aliasNorm.has(inum);
    const byClient = target.partyRe.test(String(t.party || '')) && !!onum;
    if (!byAlias && !byClient) continue;
    changes.push({
      collection: 'Transaction', id: String(t._id),
      from: t.orderNumber == null ? '' : String(t.orderNumber), to: canonical,
      type: t.type, amount: Number(t.amount) || 0,
      party: t.party || '', description: t.description || '',
      invoiceNumber: t.invoiceNumber || '',
    });
  }

  // Order docs: match by alias number, or the client's name on a non-canonical number.
  for (const o of ordersArr) {
    if (!o || o._id == null || o.archived) continue;
    const onum = normalizeOrderNumber(o.orderNumber);
    if (onum === canonical) continue;          // the canonical order itself — leave it
    const byAlias = aliasNorm.has(onum);
    const byClient = recordIsClient(target, o) && !!onum;
    if (!byAlias && !byClient) continue;
    changes.push({
      collection: 'Order', id: String(o._id),
      from: o.orderNumber == null ? '' : String(o.orderNumber), to: canonical,
      client: o.companyName || o.clientName || '', status: o.status || '',
      totalValue: Number(o.totalValue) || 0,
    });
  }

  const txnCount = changes.filter((c) => c.collection === 'Transaction').length;
  const orderCount = changes.filter((c) => c.collection === 'Order').length;
  return {
    target: { key: target.key, label: target.label },
    canonical,
    canonicalChanged: canonical !== normalizeOrderNumber(target.canonical),
    changes, txnCount, orderCount, count: changes.length,
  };
}

// Build the full plan across all targets (or one, if opts.targetKey is given).
function buildReconcilePlan(transactions, orders, opts = {}) {
  const targets = opts.targetKey ? [getTarget(opts.targetKey)].filter(Boolean) : TARGETS;
  const plans = targets.map((t) => planForTarget(t, transactions, orders)).filter((p) => p.count > 0);
  const count = plans.reduce((s, p) => s + p.count, 0);
  return {
    summary: {
      count,
      txnCount: plans.reduce((s, p) => s + p.txnCount, 0),
      orderCount: plans.reduce((s, p) => s + p.orderCount, 0),
      orders: plans.length,           // how many distinct orders need reconciling
    },
    plans,
  };
}

module.exports = {
  buildReconcilePlan, planForTarget, getTarget, recordIsClient,
  normalizeOrderNumber, deriveCompanyKey, TARGETS,
};
