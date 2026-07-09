// services/orderDedup.js
//
// Pure, unit-tested detection for the "same job imported twice" problem: a real
// project order (e.g. #61 / project #83, carrying quote lines / confirmation) and
// a bare QuickBooks/Notion-imported order (e.g. invoice #1016, importedFrom
// 'notion', just an amount) for the SAME job — same company, same money. The
// existing reconcile only dedups by order NUMBER, so these slip through as two
// orders and double-count every accrual/company stat.
//
// SAFETY — this only proposes; the controller archives (never deletes) under a
// reversible batch. The matching is deliberately conservative:
//   • Same companyKey AND same rounded totalValue (> 0).
//   • The group contains BOTH a real project order (keep) AND a bare 'notion'
//     import with no project identity (archive). If a money-group has no clear
//     project twin, or no bare-import twin, it is LEFT ALONE — we never guess.
//   • When both order dates are present they must be within DATE_WINDOW_DAYS
//     (same job's invoice vs order date are days apart, not months). A missing
//     date doesn't block (amount + company + import-pattern is already strong).

const { hasConfirmationContent } = require('../models/Order');

const DATE_WINDOW_DAYS = 45;
const roundCents = (v) => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

// A real, owner-built project order — the canonical record to KEEP. Identified by
// project identity or real quote/confirmation content, none of which a bare
// invoice import carries.
function isProjectOrder(o) {
  return !!(
    (o.projectNumber && String(o.projectNumber).trim()) ||
    (Array.isArray(o.quoteLines) && o.quoteLines.length > 0) ||
    hasConfirmationContent(o.confirmation)
  );
}

// A bare invoice import — the redundant copy to ARCHIVE. From a 'notion'/QB import
// and carrying NO project identity or quote/confirmation content of its own.
function isBareImport(o) {
  if (isProjectOrder(o)) return false;
  return /notion|quickbooks|\bqb\b/i.test(String(o.importedFrom || ''));
}

function datesOk(a, b) {
  if (!a || !b) return true;                 // a missing date doesn't block
  const da = new Date(a).getTime(), db = new Date(b).getTime();
  if (isNaN(da) || isNaN(db)) return true;
  return Math.abs(da - db) <= DATE_WINDOW_DAYS * 86400000;
}

// Group active orders by companyKey → by rounded amount, and within each money
// group propose archiving the bare-import twin(s) when a real project twin exists.
// Returns { groups:[{ companyKey, amount, keep:[...], archive:[...] }], toArchive:[...] }.
function planOrderDedup(orders) {
  const active = (Array.isArray(orders) ? orders : [])
    .filter((o) => o && !o.archived && o.status !== 'cancelled');

  const byCompany = new Map();
  for (const o of active) {
    const k = o.companyKey || '';
    if (!k) continue;
    if (!byCompany.has(k)) byCompany.set(k, []);
    byCompany.get(k).push(o);
  }

  const groups = [];
  for (const [companyKey, list] of byCompany) {
    const byAmt = new Map();
    for (const o of list) {
      const amt = roundCents(o.totalValue);
      if (amt <= 0) continue;
      if (!byAmt.has(amt)) byAmt.set(amt, []);
      byAmt.get(amt).push(o);
    }
    for (const [amount, os] of byAmt) {
      if (os.length < 2) continue;
      const keep = os.filter(isProjectOrder);
      const importsRaw = os.filter(isBareImport);
      if (keep.length === 0 || importsRaw.length === 0) continue;   // no clear pair → leave alone
      // Only archive an import whose date is compatible with a kept twin.
      const archive = importsRaw.filter((imp) => keep.some((k) => datesOk(imp.orderDate, k.orderDate)));
      if (archive.length === 0) continue;
      groups.push({ companyKey, amount, keep, archive });
    }
  }
  const toArchive = groups.flatMap((g) => g.archive);
  return { groups, toArchive };
}

module.exports = { planOrderDedup, isProjectOrder, isBareImport, roundCents, DATE_WINDOW_DAYS };
