// controllers/businessStats.js
//
// GET /api/orders/stats/business — the questions the owner asked for
// ("theres gotta be so much data im missing that can be useufl also like how
// poplar products are. maybe just having stats overall") answered off data the
// system has been storing the whole time and never surfaced.
//
// Nothing new is collected here. Every number below comes from quoteLines,
// confirmation items, Client.leadSource, Order.closeout and the PO lifecycle —
// fields that already exist. The reason none of it was answerable is that
// nothing ever aggregated across orders.
//
// Read-only, and every section degrades to an empty list rather than a zero:
// "no data yet" and "zero" are different answers, and a stat panel that shows
// 0% win rate because nothing has been tagged is worse than one that says so.

const Order = require('../models/Order');
const Client = require('../models/Client');
const PurchaseOrder = require('../models/PurchaseOrder');

const n = (v) => (Number(v) > 0 ? Number(v) : 0);
const round1 = (v) => Math.round(v * 10) / 10;
const pct = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : null);

// A product's identity for counting. The description is what the owner types and
// what the client reads, so it is the honest grouping key — style codes are
// blank on promo lines and on anything hand-entered.
//
// Normalized so "Gildan 5000" and "gildan 5000 " are one product; the display
// name keeps the first spelling seen, because that is the owner's own wording.
function productKey(line) {
  const raw = String((line && (line.description || line.styleCode)) || '').trim();
  return raw ? raw.toLowerCase().replace(/\s+/g, ' ') : '';
}

// PURE (no DB) — exported for tests.
//
// Counts each product ONCE PER ORDER, not once per quote line. A design grid
// pitching one shirt at 50/100/150 is three lines and one product; counting
// lines would rank whatever the owner happened to offer the most tiers of.
function productPopularity(orders) {
  const quoted = new Map();
  const ordered = new Map();

  for (const o of (orders || [])) {
    if (!o) continue;
    const seenQ = new Set();
    for (const l of (o.quoteLines || [])) {
      if (!l || l.hiddenFromClient) continue;
      const k = productKey(l);
      if (!k || seenQ.has(k)) continue;
      seenQ.add(k);
      const row = quoted.get(k) || { key: k, name: String(l.description || l.styleCode || '').trim(), orders: 0, units: 0, revenue: 0 };
      row.orders += 1;
      quoted.set(k, row);
    }

    // What was actually SOLD — the confirmation is the agreed document, so it is
    // the only honest source for units and revenue.
    const seenO = new Set();
    for (const it of ((o.confirmation && o.confirmation.items) || [])) {
      if (!it) continue;
      const k = productKey(it);
      if (!k) continue;
      const units = (it.sizes || []).reduce((t, s) => t + n(s && s.qty), 0) || n(it.qty);
      const row = ordered.get(k) || { key: k, name: String(it.description || '').trim(), orders: 0, units: 0, revenue: 0 };
      if (!seenO.has(k)) { row.orders += 1; seenO.add(k); }
      row.units += units;
      row.revenue += units * n(it.unitPrice);
      ordered.set(k, row);
    }
  }

  const top = (m, by) => [...m.values()]
    .sort((a, b) => b[by] - a[by] || b.orders - a.orders)
    .slice(0, 12)
    .map((r) => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }));

  return { mostQuoted: top(quoted, 'orders'), mostOrdered: top(ordered, 'units') };
}

// PURE — exported for tests.
//
// Win rate per channel. A "win" is a client who has at least one placed order;
// the denominator is every client tagged with that source. Untagged clients are
// reported SEPARATELY rather than lumped into a bucket, because until the new
// picker gets used that bucket is almost everyone and would drown the real ones.
function winRateBySource(clients, wonKeys) {
  const bySource = new Map();
  let untagged = 0;
  for (const c of (clients || [])) {
    if (!c) continue;
    const src = String(c.leadSource || '').trim();
    if (!src) { untagged += 1; continue; }
    const row = bySource.get(src) || { source: src, leads: 0, won: 0 };
    row.leads += 1;
    if (wonKeys.has(String(c.companyKey || ''))) row.won += 1;
    bySource.set(src, row);
  }
  const rows = [...bySource.values()]
    .map((r) => ({ ...r, winRatePct: pct(r.won, r.leads) }))
    .sort((a, b) => (b.winRatePct ?? -1) - (a.winRatePct ?? -1) || b.leads - a.leads);
  return { rows, untagged };
}

// PURE — exported for tests.
//
// A printer's measured record, which is the whole reason the closeout and PO
// lifecycle fields exist. Only jobs that were actually closed out count: an
// order nobody reviewed says nothing about the printer, and treating silence as
// success would make every printer look perfect.
function printerPerformance(orders) {
  const by = new Map();
  for (const o of (orders || [])) {
    if (!o) continue;
    const name = String(o.printerName || '').trim();
    const c = o.closeout;
    if (!name || !c || !c.at) continue;
    const row = by.get(name) || { printer: name, jobs: 0, onTime: 0, rated: 0, ratingSum: 0, reprints: 0, reworkCost: 0, complaints: 0 };
    row.jobs += 1;
    if (c.onTime === true) row.onTime += 1;
    if (n(c.rating) > 0) { row.rated += 1; row.ratingSum += n(c.rating); }
    row.reprints += n(c.reprintQty);
    row.reworkCost += n(c.reworkCost);
    if (c.clientComplaint) row.complaints += 1;
    by.set(name, row);
  }
  return [...by.values()]
    .map((r) => ({
      printer: r.printer, jobs: r.jobs,
      onTimePct: pct(r.onTime, r.jobs),
      avgRating: r.rated > 0 ? round1(r.ratingSum / r.rated) : null,
      reprints: r.reprints,
      reworkCost: Math.round(r.reworkCost * 100) / 100,
      complaints: r.complaints,
    }))
    .sort((a, b) => b.jobs - a.jobs);
}

// PURE — exported for tests.
//
// How many customers came back. Counted per COMPANY, not per order: two orders
// from one company is a reorder, and it is the only repeat-business number the
// system can honestly produce.
function reorderRate(orders) {
  const byCompany = new Map();
  for (const o of (orders || [])) {
    if (!o) continue;
    const k = String(o.companyKey || '').trim();
    if (!k) continue;
    byCompany.set(k, (byCompany.get(k) || 0) + 1);
  }
  const companies = byCompany.size;
  const repeat = [...byCompany.values()].filter((c) => c > 1).length;
  return { companies, repeat, reorderRatePct: pct(repeat, companies) };
}

const businessStats = async (req, res) => {
  try {
    const PLACED = ['placed', 'in_production', 'shipped', 'delivered'];
    const [orders, clients, poCount] = await Promise.all([
      Order.find({ archived: { $ne: true } })
        .select('status companyKey printerName closeout quoteLines.description quoteLines.styleCode '
              + 'quoteLines.hiddenFromClient confirmation.items.description confirmation.items.qty '
              + 'confirmation.items.unitPrice confirmation.items.sizes')
        .lean(),
      Client.find({ archived: { $ne: true } }).select('companyKey leadSource interestType').lean(),
      PurchaseOrder.countDocuments({ archived: { $ne: true } }),
    ]);

    const placed = orders.filter((o) => PLACED.includes(o.status));
    const wonKeys = new Set(placed.map((o) => String(o.companyKey || '')).filter(Boolean));

    res.json({
      products: productPopularity(orders),
      leadSources: winRateBySource(clients, wonKeys),
      printers: printerPerformance(orders),
      reorders: reorderRate(placed),
      counts: {
        orders: orders.length,
        placed: placed.length,
        clients: clients.length,
        purchaseOrders: poCount,
        // How much of the closeout data actually exists yet, so the printer
        // section can say "based on 3 jobs" instead of implying it knows.
        closedOut: orders.filter((o) => o.closeout && o.closeout.at).length,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  businessStats,
  // PURE (no DB) — exported for tests.
  productPopularity, winRateBySource, printerPerformance, reorderRate, productKey,
};
