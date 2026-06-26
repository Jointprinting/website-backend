// services/financeRestart.js
//
// PURE logic for the owner-triggered "Restart finances from my budgets" flow — the
// finance analogue of services/crmReconcile.js. No DB, no Express, no I/O: every
// function takes plain data in and returns plain data out, so the whole restart is
// unit-testable against the real seed, and the endpoints (controllers/
// financeRestart.js) stay thin wrappers that (a) load the seed + live rows,
// (b) call buildRestartPlan, then (c) apply it on an explicit confirm.
//
// WHAT THE RESTART DOES (and why)
//   The owner's budget trackers are his financial source of truth. This REPLACES
//   the uncertain budget-sourced finance rows with the verified ledger, while
//   PRESERVING any manual rows he added in-app that the budget doesn't know about
//   (so his latest hand entries survive the restart). It is preview→confirm,
//   reversible (batchId + soft-restore), and idempotent.
//
// PRESERVE vs REPLACE (the safety contract)
//   • Live rows from a PRIOR restart (source 'budget') are REPLACED wholesale —
//     deleting+reinserting from the current seed is how a re-run picks up edits.
//   • Live rows that are NOT budget-sourced (manual / import / order:auto / fee:auto)
//     are KEPT, UNLESS one duplicates a seed row by the dedup signature
//     date+amount+normalizedOrderNumber (then the seed row is canonical and the
//     manual dup is dropped from the "preserve" set so the owner isn't double-
//     counted). A manual row with NO budget twin is preserved untouched.
//
// PER-ORDER GROUPING (honoring the owner's correction)
//   The budget "(Order #N)" is the owner's own manual sequence and is UNRELIABLE
//   (he mis-numbered some — e.g. Happy Leaf #141 is really project #138). So we do
//   NOT treat the budget number as order identity. groupOrders() clusters a
//   client's rows by client (canonical party) + time proximity, surfaces the
//   budget number only as a hint, and flags ambiguous/loose groupings for the
//   owner instead of guessing.

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

// Canonical order-number key — byte-for-byte identical to controllers/finances.js
// and services/crmReconcile.js so every layer lines up. '' when no digits.
function normalizeOrderNumber(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');
}

// COGS categories that net against an order's revenue (mirrors Transaction.COGS_
// CATEGORIES). Kept inline so this module is dependency-light + unit-testable; the
// controller passes the model's list to stay authoritative if it ever changes.
const DEFAULT_COGS = ['Blank COGS', 'Printer COGS', 'Shipping', 'Art', 'Commission', 'Processing Fee'];

// ── signed-amount / contribution rules (mirror controllers/finances.js) ──────
// A seed row is always a positive magnitude; the seed never emits credits, so
// `signed` is just +amount here, but we keep the shape so live rows (which CAN be
// credits) flow through the same math when mixed in.
const signed = (t) => (t && t.isCredit ? -num(t.amount) : num(t.amount));

// What ONE income row contributes to REPORTED revenue (headline + per order):
//   Customer Sales → signed; Refund → −|signed| (contra); else 0 (Owner
//   Contribution / Other never count as revenue). Identical to the live P&L.
function incomeRevenue(t) {
  if (!t || t.type !== 'income') return 0;
  if (t.category === 'Customer Sales') return signed(t);
  if (t.category === 'Refund') return -Math.abs(signed(t)) + 0;
  return 0;
}

// ── dedup signature for preserve-vs-replace ──────────────────────────────────
// Two rows are "the same transaction" iff same calendar date + same amount + same
// normalized order number. Date is reduced to yyyy-mm-dd (UTC) so a Date object
// and an ISO string compare equal. Amount is rounded to cents. This is the key the
// owner asked for: a manual row that matches a budget row on these three is the
// SAME entry (don't double); a manual row that matches none is genuinely new.
function dateKey(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}
function dedupSig(t) {
  return `${dateKey(t && t.date)}|${round2(t && t.amount)}|${normalizeOrderNumber(t && t.orderNumber)}`;
}

// ── seed row → Transaction doc shape ─────────────────────────────────────────
// Rehydrate one committed seed row into the persisted Transaction shape. The seed
// stores ISO date strings and a recordedInQB flag; map them to the model's fields.
// `source` is forced to 'budget' so a restart can find+replace exactly its own
// rows and never a manual one. `qbSynced` carries the owner's "Recorded in QB?".
function seedRowToDoc(r, batchId) {
  return {
    date: r.date ? new Date(`${r.date}T12:00:00Z`) : null, // UTC noon — calendar-day stable
    type: r.type === 'income' ? 'income' : 'expense',
    category: r.category || 'Other',
    orderNumber: normalizeOrderNumber(r.orderNumber),
    party: r.party || '',
    description: r.description || '',
    amount: Math.abs(round2(r.amount)),
    isCredit: false,
    qbSynced: !!r.recordedInQB,
    year: r.date ? Number(r.date.slice(0, 4)) : undefined,
    source: 'budget',
    restartBatchId: batchId || '',
  };
}

// ── totals / P&L over a flat row list (seed rows or docs) ─────────────────────
// Returns the headline figures + per-category breakdown the preview shows. Owner
// equity is split out (Owner Contribution / Owner Draw never touch profit), and a
// Refund nets revenue down — identical rules to the live /api/finances/summary, so
// the preview equals what the finance page will read post-apply.
function summarizeRows(rows, opts = {}) {
  const cogs = new Set(opts.cogsCategories || DEFAULT_COGS);
  let rawDebit = 0, rawCredit = 0;
  let income = 0, expense = 0, ownerContribution = 0, ownerDraw = 0, refund = 0;
  const incomeByCategory = {}, expenseByCategory = {};
  for (const t of (rows || [])) {
    if (!t) continue;
    const amt = round2(t.amount);
    if (t.type === 'income') {
      rawDebit += amt;
      if (t.category === 'Owner Contribution') { ownerContribution += amt; incomeByCategory[t.category] = round2((incomeByCategory[t.category] || 0) + amt); }
      else if (t.category === 'Refund') { refund += amt; income -= amt; incomeByCategory[t.category] = round2((incomeByCategory[t.category] || 0) - amt); }
      else { income += amt; incomeByCategory[t.category] = round2((incomeByCategory[t.category] || 0) + amt); }
    } else {
      rawCredit += amt;
      if (t.category === 'Owner Draw') ownerDraw += amt;
      else { expense += amt; expenseByCategory[t.category] = round2((expenseByCategory[t.category] || 0) + amt); }
    }
  }
  return {
    rows: (rows || []).length,
    rawCashNet: round2(rawDebit - rawCredit),       // every debit − every credit (bank truth)
    income: round2(income), expense: round2(expense), net: round2(income - expense), // P&L profit
    ownerContribution: round2(ownerContribution),
    ownerDraw: round2(ownerDraw),
    refund: round2(refund),
    incomeByCategory, expenseByCategory,
    // Cash position = profit + equity-in − equity-out = the raw cash net (kept
    // explicit so the UI can show "cash in the business" alongside profit).
    cashPosition: round2(rawDebit - rawCredit),
  };
}

// ── per-order grouping ────────────────────────────────────────────────────────
// Group rows into orders. The budget order# is NOT trusted as the cross-system
// ORDER IDENTITY (the owner mis-numbered some — Happy Leaf budget #141 is really
// project #138), but WITHIN the budget the owner DOES tag a sale and the
// COGS/shipping it paid for with the SAME number consistently — so the number is
// the reliable INTERNAL link between a sale and its costs. We therefore:
//   • Group by (client, budgetHint): a client's rows that share one budget number
//     are ONE order — this reunites "Sales - Plantabis (#139)" with "Sales -
//     Heritage (#139)" + "Shipping - UPS (#139)" into Plantabis's #139 order.
//   • For rows with NO budget number (overhead, undated late entries that carry no
//     hint), fall back to TIME-CLUSTERING within the client so a dated sale with no
//     number still forms an order; truly unattributable COGS/overhead goes to the
//     `unassigned` bucket (counted in the P&L, just not pinned to one order).
//   • A cost row's client is resolved from the UNIQUE client that sold under its
//     budget number (so "Sales - Heritage (#139)" lands on Plantabis even though
//     "Heritage" is the vendor, not the client).
// The budget number RIDES ALONG as `budgetHints` and the cross-system mismatch is
// surfaced via the curated discrepancy list — never used to assert identity.
// Each order → { client, budgetHints[], revenue, cost, profit, firstDate, lastDate,
//                rowCount, ambiguous, ambiguousReason }.
function groupOrders(rows, opts = {}) {
  const cogs = new Set(opts.cogsCategories || DEFAULT_COGS);
  const gapDays = opts.gapDays != null ? opts.gapDays : 45;
  const list = (rows || []).filter(Boolean);

  // order#-hint → the unique client that has a SALE under it (so a vendor-named
  // cost row can be routed to the client whose order it paid for). A hint claimed
  // by >1 client is ambiguous → not used to route (those costs fall to time/overhead).
  const saleClientsByHint = new Map();
  for (const t of list) {
    if (t.type === 'income' && t.category === 'Customer Sales' && t.party) {
      const h = normalizeOrderNumber(t.orderNumber);
      if (!h) continue;
      const s = saleClientsByHint.get(h) || new Set();
      s.add(t.party); saleClientsByHint.set(h, s);
    }
  }
  const uniqueClientForHint = (h) => {
    const s = h ? saleClientsByHint.get(h) : null;
    return s && s.size === 1 ? [...s][0] : null;
  };

  // Resolve each row's client. Customer-Sales → its party. Any other row with a
  // budget hint → the unique client that sold under that hint. Else null (handled
  // by time-cluster fallback / overhead).
  const clientOf = (t) => {
    if (t.type === 'income' && t.category === 'Customer Sales' && t.party) return t.party;
    return uniqueClientForHint(normalizeOrderNumber(t.orderNumber));
  };

  // Bucket A: rows WITH a budget hint AND a resolved client → keyed (client##hint).
  // Bucket B: rows with NO hint but a resolved client → per-client time-cluster.
  // Bucket C: everything else → unassigned overhead/ambiguous cost.
  const byKey = new Map();        // "client hint" → { client, hint, rows[] }
  const byClientNoHint = new Map(); // client → rows[]
  const unassigned = [];
  for (const t of list) {
    const client = clientOf(t);
    const hint = normalizeOrderNumber(t.orderNumber);
    if (client && hint) {
      const k = `${client} ${hint}`;
      const g = byKey.get(k) || { client, hint, rows: [] };
      g.rows.push(t); byKey.set(k, g);
    } else if (client) {
      const arr = byClientNoHint.get(client) || []; arr.push(t); byClientNoHint.set(client, arr);
    } else {
      unassigned.push(t);
    }
  }

  const orders = [];
  // A) one order per (client, budget hint).
  for (const { client, rows: grows } of byKey.values()) {
    orders.push(makeOrder(client, grows, cogs));
  }
  // B) hint-less rows for a client → time-cluster into order(s).
  for (const [client, crows] of byClientNoHint) {
    const withDates = crows.map((t) => ({ t, d: dateKey(t.date) })).filter((x) => x.d);
    const noDates = crows.filter((t) => !dateKey(t.date));
    withDates.sort((a, b) => a.d.localeCompare(b.d));
    let cluster = []; let lastD = null;
    const flush = () => { if (cluster.length) { orders.push(makeOrder(client, cluster.map((x) => x.t), cogs)); cluster = []; } };
    for (const x of withDates) {
      if (lastD && daysBetween(lastD, x.d) > gapDays) flush();
      cluster.push(x); lastD = x.d;
    }
    flush();
    // Undated, hint-less rows for a client: fold into that client's single existing
    // order if there's exactly one, else emit one ambiguous order to review.
    if (noDates.length) {
      const clientOrders = orders.filter((o) => o.client === client);
      if (clientOrders.length === 1) mergeRowsIntoOrder(clientOrders[0], noDates, cogs);
      else {
        const o = makeOrder(client, noDates, cogs);
        o.ambiguous = true;
        o.ambiguousReason = 'undated rows with no budget order # could not be placed among this client’s orders';
        orders.push(o);
      }
    }
  }

  orders.sort((a, b) => (Number((b.budgetHints[0]) || 0) - Number((a.budgetHints[0]) || 0)) || (b.lastDate || '').localeCompare(a.lastDate || ''));
  return {
    orders,
    unassignedCount: unassigned.length,
    unassignedCost: round2(unassigned.filter((t) => t.type === 'expense' && cogs.has(t.category)).reduce((s, t) => s + signed(t), 0)),
  };
}

function makeOrder(client, rows, cogs) {
  const o = { client, budgetHints: [], revenue: 0, cost: 0, profit: 0, firstDate: null, lastDate: null, rowCount: 0, ambiguous: false };
  mergeRowsIntoOrder(o, rows, cogs);
  return o;
}

function mergeRowsIntoOrder(o, rows, cogs) {
  const hintCount = new Map(o._hintCount || []);
  let hasSale = o._hasSale || false;
  for (const t of rows) {
    o.rowCount += 1;
    const d = dateKey(t.date);
    if (d) {
      if (!o.firstDate || d < o.firstDate) o.firstDate = d;
      if (!o.lastDate || d > o.lastDate) o.lastDate = d;
    }
    const h = normalizeOrderNumber(t.orderNumber);
    if (h) hintCount.set(h, (hintCount.get(h) || 0) + 1);
    if (t.type === 'income') {
      o.revenue = round2(o.revenue + incomeRevenue(t));
      if (t.category === 'Customer Sales') hasSale = true;
    } else if (cogs.has(t.category)) {
      o.cost = round2(o.cost + signed(t));
    }
  }
  o._hintCount = [...hintCount.entries()];
  o._hasSale = hasSale;
  o.budgetHints = [...hintCount.keys()].sort((a, b) => Number(a) - Number(b));
  o.profit = round2(o.revenue - o.cost);
  // Ambiguity signals for the owner to review (NOT a hard error):
  //   • more than one distinct budget number inside one time-cluster (the owner's
  //     numbers disagree with the time grouping), or
  //   • a cost-only cluster with no sale in it (cost we couldn't tie to revenue).
  if (o.budgetHints.length > 1) { o.ambiguous = true; o.ambiguousReason = `multiple budget order #s (${o.budgetHints.join(', ')}) fall in one time-cluster`; }
  if (!hasSale && o.cost > 0 && o.revenue === 0) { o.ambiguous = true; o.ambiguousReason = 'cost with no co-located sale'; }
  return o;
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(db - da) / 86400000;
}

// Strip the internal accumulators before returning an order to the API.
function cleanOrder(o) {
  const { _hintCount, _hasSale, ...rest } = o;
  return rest;
}

// ── discrepancies (what the owner should eyeball before confirming) ──────────
// Surfaces facts the data can't resolve on its own — the finance analogue of the
// CRM discrepancy list. Each: { kind, severity, detail, ...context }.
//   • 'order-grouping-ambiguous' — a cluster groupOrders flagged.
//   • 'budget-number-mismatch'   — a curated owner-known mismatch (e.g. Happy Leaf
//                                  budget #141 vs project #138 / invoice #1052).
//   • 'cost-without-sale'        — overhead/COGS not tied to any order's revenue.
//   • 'manual-rows-preserved'    — count of in-app rows kept (informational).
//   • 'manual-duplicate-dropped' — a manual row that duplicated a budget row.
function detectDiscrepancies(grouping, preserve, opts = {}) {
  const out = [];
  for (const o of grouping.orders) {
    if (o.ambiguous) {
      out.push({
        kind: 'order-grouping-ambiguous', severity: 'warn',
        client: o.client, budgetHints: o.budgetHints,
        detail: `${o.client}: ${o.ambiguousReason || 'grouping is uncertain'}. Revenue $${o.revenue}, cost $${o.cost}. Review which budget order #(s) this should be.`,
      });
    }
  }
  if (grouping.unassignedCost && Math.abs(grouping.unassignedCost) >= 0.01) {
    out.push({
      kind: 'cost-without-sale', severity: 'info',
      detail: `$${grouping.unassignedCost} of COGS/overhead isn't tied to any single order (no co-located sale). It still counts in the P&L; it just isn't attributed to one order's profit.`,
    });
  }
  if (preserve) {
    if (preserve.preservedCount) {
      out.push({
        kind: 'manual-rows-preserved', severity: 'info',
        detail: `${preserve.preservedCount} in-app manual transaction(s) not present in the budget will be KEPT (your latest hand entries survive the restart).`,
      });
    }
    if (preserve.droppedDuplicateCount) {
      out.push({
        kind: 'manual-duplicate-dropped', severity: 'info',
        detail: `${preserve.droppedDuplicateCount} in-app row(s) duplicate a budget row (same date + amount + order #) and won't be double-counted — the budget version is kept.`,
      });
    }
  }
  // Curated owner-known mismatches (DATA, not logic) — same pattern as the CRM
  // reconcileKnownDiscrepancies. Only surfaced when the named budget hint actually
  // appears in this seed, so a stale note drops out.
  const presentHints = new Set(grouping.orders.flatMap((o) => o.budgetHints));
  for (const k of (opts.knownDiscrepancies || [])) {
    if (!k) continue;
    if (k.budgetHint && !presentHints.has(normalizeOrderNumber(k.budgetHint))) continue;
    out.push({
      kind: k.kind || 'budget-number-mismatch',
      severity: k.severity || 'warn',
      detail: k.detail || 'Owner-flagged finance discrepancy.',
      ownerFlagged: true,
      ...(k.budgetHint ? { budgetHint: normalizeOrderNumber(k.budgetHint) } : {}),
      ...(k.projectNumber ? { projectNumber: k.projectNumber } : {}),
      ...(k.invoiceNumber ? { invoiceNumber: k.invoiceNumber } : {}),
    });
  }
  return out;
}

// ── the preserve plan: which live rows survive vs are replaced ───────────────
// Given the SEED rows and the CURRENT live rows, decide:
//   • toDelete   — live rows from a prior restart (source 'budget') to remove.
//   • toInsert   — the seed rows to insert (all of them; they ARE the truth now).
//   • toPreserve — non-budget live rows with NO seed twin (kept untouched).
//   • droppedDuplicates — non-budget live rows that DO duplicate a seed row (the
//                 owner is warned; the budget row wins so we don't double-count).
// Pure: pass the already-fetched arrays in.
function buildPreservePlan(seedRows, liveRows) {
  const seedSigs = new Set((seedRows || []).map(dedupSig));
  const toDelete = [];
  const toPreserve = [];
  const droppedDuplicates = [];
  for (const t of (liveRows || [])) {
    if (!t) continue;
    if (t.source === 'budget') { toDelete.push(t); continue; }   // prior restart → replace
    // A non-budget (manual/import/order:auto/fee:auto) row:
    if (seedSigs.has(dedupSig(t))) droppedDuplicates.push(t);     // duplicates the budget → drop (budget wins)
    else toPreserve.push(t);                                      // genuinely new → keep
  }
  return {
    toDeleteCount: toDelete.length,
    toDelete,
    toPreserve,
    preservedCount: toPreserve.length,
    droppedDuplicates,
    droppedDuplicateCount: droppedDuplicates.length,
    toInsertCount: (seedRows || []).length,
  };
}

// ── the PLAN the preview returns and the apply consumes ──────────────────────
function buildRestartPlan(seed, current = {}, opts = {}) {
  const seedRows = (seed && Array.isArray(seed.rows)) ? seed.rows : [];
  const liveRows = Array.isArray(current.transactions) ? current.transactions : [];
  const cogsCategories = opts.cogsCategories || DEFAULT_COGS;

  const totals = summarizeRows(seedRows, { cogsCategories });
  const grouping = groupOrders(seedRows, { cogsCategories, gapDays: opts.gapDays });
  const preserve = buildPreservePlan(seedRows, liveRows);
  const discrepancies = detectDiscrepancies(grouping, preserve, { knownDiscrepancies: opts.knownDiscrepancies });

  const orders = grouping.orders.map(cleanOrder);
  const summary = {
    seedRows: seedRows.length,
    rawCashNet: totals.rawCashNet,
    income: totals.income, expense: totals.expense, net: totals.net,
    ownerContribution: totals.ownerContribution, ownerDraw: totals.ownerDraw, refund: totals.refund,
    cashPosition: totals.cashPosition,
    orderCount: orders.length,
    ambiguousOrders: orders.filter((o) => o.ambiguous).length,
    liveRows: liveRows.length,
    budgetRowsToReplace: preserve.toDeleteCount,
    manualRowsPreserved: preserve.preservedCount,
    manualDuplicatesDropped: preserve.droppedDuplicateCount,
    rowsToInsert: preserve.toInsertCount,
    discrepancies: discrepancies.length,
    // A re-run is a no-op once the live budget rows already equal the seed AND
    // nothing new would be inserted/deleted. (Exact equality is checked in apply
    // by signature; this is the cheap headline.)
    netAfter: totals.net,
  };

  return {
    summary, totals,
    byOrder: orders,
    discrepancies,
    preserve,            // carries toDelete/toPreserve arrays for apply
    perCategory: { income: totals.incomeByCategory, expense: totals.expenseByCategory },
  };
}

module.exports = {
  buildRestartPlan,
  summarizeRows,
  groupOrders,
  buildPreservePlan,
  detectDiscrepancies,
  seedRowToDoc,
  dedupSig,
  dateKey,
  normalizeOrderNumber,
  incomeRevenue,
  signed,
  cleanOrder,
  DEFAULT_COGS,
};
