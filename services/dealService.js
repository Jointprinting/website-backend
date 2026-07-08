// services/dealService.js
//
// Pure business logic for the deal pipeline — the derive-client rule and the
// reversible "seed deals from existing orders" migration plan. Kept pure (plain
// arrays in, plain plan out) so the whole thing is unit-testable with no DB, and
// so the migration is a two-step "plan → apply" the controller can dry-run.

const { dealStageFromOrderStatus } = require('../models/Deal');

// ── Derive-client ─────────────────────────────────────────────────────────────

// A business is a CLIENT once it has ≥1 WON deal. This replaces the old hand-set
// "won"/"customer" company stage: winning a deal is the single source of truth,
// so the two can never disagree again. Archived deals don't count. PURE.
function isClientFromDeals(deals) {
  return (Array.isArray(deals) ? deals : [])
    .some((d) => d && !d.archived && d.stage === 'won');
}

// The business's derived pipeline status from its deals (+ order reality as a
// backstop, since a placed order is a win even if no deal was recorded):
//   client   — has a won deal, or a placed order
//   active   — has an open deal (qualifying/quoted) in play
//   prospect — none of the above (a lead we haven't opened a deal with yet)
// PURE. `hasPlacedOrder` folds in the existing order-reality signal.
function deriveBusinessStatus(deals, hasPlacedOrder = false) {
  const arr = (Array.isArray(deals) ? deals : []).filter((d) => d && !d.archived);
  if (hasPlacedOrder || arr.some((d) => d.stage === 'won')) return 'client';
  if (arr.some((d) => d.stage === 'qualifying' || d.stage === 'quoted')) return 'active';
  return 'prospect';
}

// ── Reversible migration: seed deals from existing orders + won companies ──────

// A human-ish title for a deal seeded from an order.
function orderDealTitle(order) {
  const n = order.orderNumber || order.projectNumber;
  return n ? `Order #${n}` : (order.companyName || order.clientName || 'Order');
}

// ── Order → logical-JOB collapsing (de-dup) ───────────────────────────────────
// One logical job routinely exists as MORE THAN ONE Order document (a quote/project
// doc carrying the projectNumber and a placed doc carrying the orderNumber; plus
// import/reconcile duplicates). Keying a deal per Order._id therefore double-counts
// a job — the bug that put the same order on the board twice (one card #<project>,
// one card #<order>). We collapse Orders to jobs FIRST, then emit one deal per job.

// Normalize a project number for identity: strip a leading '#' and leading zeros,
// KEEP a trailing "-N" add-on suffix (24 and 24-2 are distinct jobs). Mirrors the
// ecosystem's digits-first normalization (orderReconcile/financeDedupe/dataCleanup).
function normProjNum(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/^#/, '');
  return s ? s.replace(/^0+(?=\d)/, '') : '';
}
// Normalize an invoice/order number for identity: digits only, leading zeros stripped.
function normOrderNum(v) {
  const s = String(v == null ? '' : v).replace(/[^\d]/g, '');
  return s ? s.replace(/^0+(?=\d)/, '') : '';
}
const firstNonEmpty = (arr) => (arr.find((x) => x != null && String(x).trim() !== '') || '');

// Group orders into logical jobs: union any two orders of the SAME company that
// share a (namespaced) project OR order number. A number-less order stands alone.
// Pure union-find; returns an array of order-groups. Two different jobs never merge
// (project/order numbers are namespaced apart, and grouping is per companyKey).
function groupOrdersByJob(orders) {
  const parent = orders.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const tokenToIdx = new Map();
  orders.forEach((o, i) => {
    const key = o.companyKey || '';
    const p = normProjNum(o.projectNumber);
    const q = normOrderNum(o.orderNumber);
    const tokens = [];
    if (p) tokens.push(`${key}#P#${p}`);
    if (q) tokens.push(`${key}#O#${q}`);
    for (const t of tokens) {
      if (tokenToIdx.has(t)) union(i, tokenToIdx.get(t));
      else tokenToIdx.set(t, i);
    }
  });
  const groups = new Map();
  orders.forEach((_, i) => {
    const r = find(i);
    (groups.get(r) || groups.set(r, []).get(r)).push(orders[i]);
  });
  return [...groups.values()];
}

// Pick the most authoritative Order doc to represent a job: has BOTH numbers >
// placed/won > higher value > oldest (a stable tiebreak). Never an archived doc
// (they're excluded upstream by the migration query, but guard anyway).
function pickSurvivor(group) {
  const score = (o) => [
    (o.projectNumber && o.orderNumber) ? 1 : 0,
    dealStageFromOrderStatus(o.status) === 'won' ? 1 : 0,
    Number(o.totalValue) || 0,
  ];
  return group.slice().sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sb[i] !== sa[i]) return sb[i] - sa[i];
    const da = new Date(a.orderDate || a.updatedAt || 0).getTime();
    const db = new Date(b.orderDate || b.updatedAt || 0).getTime();
    return da - db; // oldest wins the tie
  })[0];
}

// Plan (do NOT apply) the deals to create so every existing JOB becomes ONE deal
// card and every already-won company keeps its client status. PURE + idempotent:
//   • one deal per logical job (Orders collapsed via groupOrdersByJob) that doesn't
//     already have one — the deal carries BOTH the project & order numbers and is
//     sourced from the survivor Order._id; stage mapped from the survivor's status
//   • for a company that's flagged won/customer but has NO orders, one synthetic
//     'won' deal so its client status survives the switch to derive-from-deals
// Re-running with the same inputs yields an empty plan (skip a whole job if ANY of
// its orders already seeded a deal — so a re-run never re-emits under a new survivor).
//
// Args are plain lean docs: orders[], clients[], existingDeals[]. Returns
// { toCreate: [dealDoc...], skippedOrders, skippedWonCompanies } where each
// dealDoc is ready to insert (stamped with origin:'migration' + migrationBatch).
function planMigration({ orders = [], clients = [], existingDeals = [], batchId = '' } = {}) {
  const haveOrderIds = new Set(
    existingDeals.map((d) => String(d.sourceOrderId || '')).filter(Boolean)
  );
  // Companies that already own a won deal (so we don't synthesize a second one).
  const wonCompanyKeys = new Set(
    existingDeals.filter((d) => d && d.stage === 'won').map((d) => d.companyKey)
  );
  const companiesWithOrders = new Set(orders.map((o) => o.companyKey));

  const toCreate = [];
  let skippedOrders = 0;

  // 1) One deal per logical JOB (collapse duplicate Order docs first). A cancelled
  //    order is a real lost deal worth keeping, so it isn't filtered.
  for (const group of groupOrdersByJob(orders)) {
    // Idempotent at the JOB level: if ANY order in this job already seeded a deal,
    // skip the whole job so a re-run never re-emits it under a different survivor.
    if (group.some((o) => haveOrderIds.has(String(o._id || '')))) { skippedOrders += group.length; continue; }
    const survivor = pickSurvivor(group);
    const id = String(survivor._id || '');
    if (!id) { skippedOrders += group.length; continue; }
    const stage = dealStageFromOrderStatus(survivor.status);
    // Merge the identifying numbers across the whole job so the one deal carries the
    // full linkage the ecosystem joins on (project # and invoice #).
    const orderNumber   = firstNonEmpty(group.map((o) => o.orderNumber));
    const projectNumber = firstNonEmpty(group.map((o) => o.projectNumber));
    toCreate.push({
      companyKey:    survivor.companyKey || '',
      companyName:   survivor.companyName || survivor.clientName || '',
      title:         orderDealTitle({ orderNumber, projectNumber, companyName: survivor.companyName, clientName: survivor.clientName }),
      stage,
      value:         Number(survivor.totalValue) || 0,
      agentId:       survivor.agentId || '',
      orderNumber,
      projectNumber,
      sourceOrderId: id,
      origin:        'migration',
      migrationBatch: batchId,
      wonAt:  stage === 'won'  ? (survivor.orderDate || survivor.updatedAt || null) : null,
      lostAt: stage === 'lost' ? (survivor.updatedAt || null) : null,
    });
    if (stage === 'won') wonCompanyKeys.add(survivor.companyKey);
  }

  // 2) Won/customer companies with NO orders → one synthetic won deal so the
  //    "≥1 won deal = client" rule keeps them a client after the switch.
  let skippedWonCompanies = 0;
  for (const c of clients) {
    const key = c.companyKey;
    const isWonCompany = c.stage === 'won' || c.stage === 'customer';
    if (!isWonCompany) continue;
    if (companiesWithOrders.has(key) || wonCompanyKeys.has(key)) { skippedWonCompanies++; continue; }
    toCreate.push({
      companyKey:    key,
      companyName:   c.companyName || c.clientName || '',
      title:         'Won (before deals)',
      stage:         'won',
      value:         Number(c.dealValue) || 0,
      agentId:       c.agentId || '',
      orderNumber:   '',
      projectNumber: '',
      sourceOrderId: '',
      origin:        'migration',
      migrationBatch: batchId,
      wonAt:  c.updatedAt || null,
      lostAt: null,
    });
    wonCompanyKeys.add(key);
  }

  return { toCreate, skippedOrders, skippedWonCompanies };
}

module.exports = {
  isClientFromDeals,
  deriveBusinessStatus,
  orderDealTitle,
  planMigration,
  // exposed for unit tests
  groupOrdersByJob,
  pickSurvivor,
};
