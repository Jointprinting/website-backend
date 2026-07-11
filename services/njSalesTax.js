// services/njSalesTax.js
//
// NJ sales-tax filing helper — the numbers behind the hub's quarterly reminder.
// New Jersey ST-50 returns are due the 20th of the month AFTER each quarter:
//   Q1 (Jan–Mar) → Apr 20 · Q2 (Apr–Jun) → Jul 20 ·
//   Q3 (Jul–Sep) → Oct 20 · Q4 (Oct–Dec) → Jan 20 (next year)
// This does NOT file anything — it pulls the orders that charged NJ sales tax
// in the period and totals them so the owner can double-check against the
// state portal in seconds. PURE date/tax math here; the DB query lives in the
// finances controller. Dates are treated in ET (the owner's books) via a
// fixed −5/−4 offset kept simple: we bucket on calendar month/day, which is
// unambiguous for quarter boundaries.

const { computeLocationTax, isTaxCustomLine } = require('../models/Order');

const round2 = (v) => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

// The four NJ quarters, keyed by the due month. `q` is 0-based quarter index.
const QUARTERS = [
  { q: 0, label: 'Q1 (Jan–Mar)', startMonth: 0,  endMonth: 2,  dueMonth: 3,  dueDay: 20 }, // due Apr 20
  { q: 1, label: 'Q2 (Apr–Jun)', startMonth: 3,  endMonth: 5,  dueMonth: 6,  dueDay: 20 }, // due Jul 20
  { q: 2, label: 'Q3 (Jul–Sep)', startMonth: 6,  endMonth: 8,  dueMonth: 9,  dueDay: 20 }, // due Oct 20
  { q: 3, label: 'Q4 (Oct–Dec)', startMonth: 9,  endMonth: 11, dueMonth: 0,  dueDay: 20 }, // due Jan 20 (next yr)
];

// The window a reminder shows: from 2 weeks before the due date through 5 days
// after (a small grace so it doesn't vanish the moment it's due).
const REMIND_BEFORE_DAYS = 14;
const GRACE_AFTER_DAYS = 5;

// For a quarter spec + the year its SALES fall in, the actual due Date. Q4's
// due date rolls into January of the FOLLOWING year.
function dueDateFor(spec, salesYear) {
  const dueYear = spec.q === 3 ? salesYear + 1 : salesYear;
  return new Date(dueYear, spec.dueMonth, spec.dueDay, 0, 0, 0);
}

// The quarter whose sales a given date belongs to.
function quarterOf(date) {
  const m = date.getMonth();
  return QUARTERS.find((s) => m >= s.startMonth && m <= s.endMonth);
}

// The filing that's "active" for the reminder at `now`: the most recent quarter
// whose due date sits inside [due − 14d, due + 5d]. Returns null when no filing
// is currently in its reminder window (most of the year). Checks the current
// candidate and the previous quarter (whose due date can spill into `now`).
function activeFiling(now = new Date()) {
  const candidates = [];
  const y = now.getFullYear();
  // This year's four quarters + last year's Q4 (its Jan-20 due date lands early
  // in `now`'s year).
  for (const spec of QUARTERS) candidates.push({ spec, salesYear: y });
  candidates.push({ spec: QUARTERS[3], salesYear: y - 1 });
  let best = null;
  for (const c of candidates) {
    const due = dueDateFor(c.spec, c.salesYear);
    const openFrom = new Date(due.getTime() - REMIND_BEFORE_DAYS * 86400000);
    const closeAt = new Date(due.getTime() + GRACE_AFTER_DAYS * 86400000);
    if (now >= openFrom && now <= closeAt) {
      if (!best || due < best.due) best = { spec: c.spec, salesYear: c.salesYear, due };
    }
  }
  if (!best) return null;
  const start = new Date(best.salesYear, best.spec.startMonth, 1, 0, 0, 0);
  const end = new Date(best.salesYear, best.spec.endMonth + 1, 1, 0, 0, 0); // exclusive
  const daysUntilDue = Math.ceil((best.due.getTime() - now.getTime()) / 86400000);
  return {
    label: best.spec.label,
    salesYear: best.salesYear,
    periodStart: start,
    periodEnd: end,
    dueDate: best.due,
    daysUntilDue,
  };
}

// The date an order's sale is booked to (what buckets it into a tax quarter):
// the invoice/orderDate if set, else the paid date, else createdAt. PURE.
function orderSaleDate(order) {
  const d = order.orderDate || order.paidAt
    || (order.tracking && (order.tracking.steps || []).find((s) => s && s.id === 'order_paid' && s.completedAt) || {}).completedAt
    || order.createdAt;
  const dt = d ? new Date(d) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt : null;
}

// NJ sales tax charged on ONE order: the tax on any NJ ship-to location (the
// per-location path), or a legacy single "NJ tax" custom line when the order
// shipped to NJ. Returns { taxable, tax } in dollars. PURE.
function njTaxForOrder(order) {
  const conf = order && order.confirmation;
  if (!conf) return { taxable: 0, tax: 0 };
  const n = (v) => Number(v) || 0;

  const locTax = computeLocationTax(conf);
  if (locTax.active) {
    const shipTos = Array.isArray(conf.shipTos) ? conf.shipTos : [];
    const njKeys = new Set(shipTos
      .filter((st) => st && String(st.state || '').toUpperCase() === 'NJ' && n(st.taxRate) > 0)
      .map((st) => st.key));
    let tax = 0; let taxable = 0;
    for (const line of locTax.lines) {
      if (njKeys.has(line.key)) { tax += n(line.value); taxable += n(line.subtotal); }
    }
    return { taxable: round2(taxable), tax: round2(tax) };
  }

  // Legacy single-location: a "NJ tax" custom line applied to the items subtotal,
  // counted only when the order actually shipped to NJ.
  const shipState = String(
    (order.shipToState) || (conf.shipping && conf.shipping.state) || '',
  ).toUpperCase();
  if (shipState !== 'NJ') return { taxable: 0, tax: 0 };
  const taxLine = (Array.isArray(conf.customLines) ? conf.customLines : []).find(isTaxCustomLine);
  if (!taxLine) return { taxable: 0, tax: 0 };
  const itemsSubtotal = (Array.isArray(conf.items) ? conf.items : []).reduce(
    (s, it) => s + ((it && it.sizes) || []).reduce((ss, sz) => ss + n(sz.qty) * n(sz.unitPrice), 0), 0);
  const tax = taxLine.isPercent ? itemsSubtotal * n(taxLine.amount) / 100 : n(taxLine.amount);
  return { taxable: round2(itemsSubtotal), tax: round2(tax) };
}

module.exports = {
  QUARTERS, dueDateFor, quarterOf, activeFiling, orderSaleDate, njTaxForOrder, round2,
  REMIND_BEFORE_DAYS, GRACE_AFTER_DAYS,
};
