// Finance tracker — the clean ledger + analytics that replace the manual
// spreadsheet and the QuickBooks re-keying. Source of truth is the DB; the
// owner keeps an owned copy via CSV export (downloaded on demand at tax time —
// not auto-emailed). Income vs expense is explicit; COGS links to orders for
// per-order and per-client margin. Admin-only.

const Transaction = require('../models/Transaction');
const r2 = require('../services/r2');

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

// Safe percentage: (numer / denom) × 100, rounded to 2 decimals. Returns 0 when
// the denominator is below a cent in magnitude (or non-finite), so a margin/share
// can never blow up to Infinity/NaN/a meaningless 9,999,900% off a sub-cent or
// negative-noise base. Any denom whose absolute value is < $0.005 is "approx zero".
const pct = (numer, denom) => {
  const d = num(denom);
  if (!Number.isFinite(d) || Math.abs(d) < 0.005) return 0;
  return round2((num(numer) / d) * 100);
};

// A credit/return reverses the direction of its `type` while staying positive in
// the DB: an EXPENSE credit (supplier credit) nets DOWN cost; an INCOME credit
// (customer refund) nets DOWN revenue. Every total is computed on this signed
// amount so credits subtract instead of adding. Legacy rows (no isCredit) sign
// to +amount, so nothing about historical numbers changes.
const signed = (t) => (t && t.isCredit ? -num(t.amount) : num(t.amount));
// The same rule as a Mongo aggregation expression on the current document.
const SIGNED_AMOUNT = { $cond: [{ $eq: ['$isCredit', true] }, { $multiply: ['$amount', -1] }, '$amount'] };

// What a per-{category} income subtotal contributes to REPORTED income (the P&L
// headline and the monthly trend both use this). `signedTotal` is the already-
// signed sum for one income category in a period. Rules:
//   • 'Owner Contribution' is equity IN, not earnings → contributes 0.
//   • 'Refund' is contra-revenue (money handed back to a customer) → contributes
//     −|signedTotal|, so it REDUCES income whether the refund was booked as a
//     plain positive amount or as an income credit (abs() can't be flipped
//     positive by isCredit the way the raw signed total could).
//   • everything else → contributes its signed total as-is.
// Pure + exported so the contra-revenue rule is unit-testable without a DB.
function incomeContribution(category, signedTotal) {
  const v = num(signedTotal);
  if (category === 'Owner Contribution') return 0;
  if (category === 'Refund') return -Math.abs(v) + 0;   // + 0 normalizes -0 to 0
  return v;
}

// A transaction belongs to the year of its DATE. We filter on the date itself,
// not the denormalized `year` field, which can drift when a date is edited (a
// Dec-2025 row left tagged 2026 was surfacing as a phantom "Dec" bar in the 2026
// trend and padding the 2026 totals). UTC bounds to match $year/$month grouping.
function yearDateMatch(y) {
  if (!y) return {};
  const year = Number(y);
  return { date: { $gte: new Date(Date.UTC(year, 0, 1)), $lt: new Date(Date.UTC(year + 1, 0, 1)) } };
}

// ── tiny CSV helpers (handle quoted fields with commas) ─────────────────────
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// POST /api/finances/import  — body: { csv } in the JP Ledger schema
// (Date,Type,Category,Order #,Customer/Vendor,Description,Amount,QB Synced).
// Replaces all imported rows (source:'import') so re-importing is idempotent.
const importCsv = async (req, res) => {
  try {
    const text = (req.body && req.body.csv) || '';
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return res.status(400).json({ message: 'CSV has no rows.' });
    const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const col = (name) => header.findIndex((h) => h.includes(name));
    const ix = {
      date: col('date'), type: col('type'), category: col('category'),
      order: col('order'), party: header.findIndex((h) => h.includes('customer') || h.includes('vendor')),
      desc: col('description'), amount: col('amount'), qb: col('qb'),
    };
    const docs = [];
    for (let i = 1; i < lines.length; i++) {
      const c = parseCsvLine(lines[i]);
      const date = new Date(c[ix.date]);
      const rawAmount = num(c[ix.amount]);
      const amount = Math.abs(rawAmount);
      if (isNaN(date.getTime()) || !amount) continue;
      docs.push({
        date,
        type: /income/i.test(c[ix.type]) ? 'income' : 'expense',
        category: (c[ix.category] || 'Other').trim(),
        orderNumber: String(c[ix.order] || '').replace(/[^0-9]/g, ''),
        party: (c[ix.party] || '').trim(),
        description: (c[ix.desc] || '').trim(),
        amount,
        isCredit: rawAmount < 0,   // a negative ledger amount = a credit / return

        qbSynced: /yes/i.test(c[ix.qb] || ''),
        year: date.getUTCFullYear(),
        source: 'import',
      });
    }
    await Transaction.deleteMany({ source: 'import' });
    await Transaction.insertMany(docs);
    res.json({ imported: docs.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/finances/transactions?year=&type=&category=&orderNumber=
const list = async (req, res) => {
  try {
    const q = yearDateMatch(req.query.year);
    if (req.query.type) q.type = req.query.type;
    if (req.query.category) q.category = req.query.category;
    if (req.query.orderNumber) {
      // Match the canonical number against every stored leading-zero variant: a
      // request for "21" matches stored "21", "021", "0000021" (stored numbers are
      // digits-only). Anchored ^0*<digits>$ so "21" never matches "121"/"210".
      const key = normalizeOrderNumber(req.query.orderNumber);
      q.orderNumber = key ? new RegExp(`^0*${key}$`) : '';
    }
    const txns = await Transaction.find(q).sort({ date: 1 }).lean();
    res.json({ transactions: txns });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Accepts an optional `receiptDataUrl` (image or PDF) — stored to R2 and linked
// so the invoice/receipt lives with the transaction (replacing the manual
// "download → personal Drive" step). The actual amount entered is the source of
// truth for COGS.
const create = async (req, res) => {
  try {
    const body = { ...req.body };
    const dataUrl = body.receiptDataUrl; delete body.receiptDataUrl;
    if (dataUrl && r2.isR2Configured()) {
      const m = String(dataUrl).match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
      if (m) body.receiptUrl = await r2.uploadBuffer(Buffer.from(m[2], 'base64'), m[1].toLowerCase(), 'receipts');
    }
    if (body.amount != null) body.amount = Math.abs(num(body.amount));
    res.json({ transaction: await Transaction.create(body) });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
const update = async (req, res) => {
  try {
    const body = { ...req.body };
    // Allow attaching (or replacing) a receipt on an existing entry later.
    const dataUrl = body.receiptDataUrl; delete body.receiptDataUrl;
    if (dataUrl && r2.isR2Configured()) {
      const m = String(dataUrl).match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
      if (m) body.receiptUrl = await r2.uploadBuffer(Buffer.from(m[2], 'base64'), m[1].toLowerCase(), 'receipts');
    }
    if (body.amount != null) body.amount = Math.abs(num(body.amount));
    const t = await Transaction.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true });
    if (!t) return res.status(404).json({ message: 'Not found' });
    res.json({ transaction: t });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
const remove = async (req, res) => {
  try { await Transaction.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ message: e.message }); }
};

// GET /api/finances/summary?year=  — the P&L: income, expense-by-category, net,
// %-of-spend per category. Owner equity moves are excluded from profit: Owner
// Contribution (cash the owner puts IN) isn't earnings, and Owner Draw (cash the
// owner takes OUT) isn't a business expense — both are reported on the side, not
// in net.
const summary = async (req, res) => {
  try {
    const yearMatch = yearDateMatch(req.query.year);
    const rows = await Transaction.aggregate([
      { $match: yearMatch },
      { $group: { _id: { type: '$type', category: '$category' }, total: { $sum: SIGNED_AMOUNT }, count: { $sum: 1 } } },
    ]);
    let income = 0, expense = 0, ownerContribution = 0, ownerDraw = 0;
    const expenseByCategory = {}, incomeByCategory = {};
    rows.forEach((r) => {
      const amt = round2(r.total);
      if (r._id.type === 'income') {
        if (r._id.category === 'Owner Contribution') {
          // Equity IN, not earnings — reported on the side, never in income. Its
          // breakdown row shows the real amount contributed.
          incomeByCategory[r._id.category] = amt;
          ownerContribution += amt;
        } else {
          // Contra-revenue rule: a 'Refund' nets DOWN income (the audit's inflate
          // bug); everything else counts as-is. The breakdown stores the SAME
          // contribution, so a refund shows as a negative that matches the headline.
          const contrib = incomeContribution(r._id.category, amt);
          incomeByCategory[r._id.category] = contrib;
          income += contrib;
        }
      } else if (r._id.category === 'Owner Draw') {
        // Owner Draw is equity OUT (the owner paying themselves) — NOT a cost of
        // doing business. Must not count against profit or show up as "spend".
        ownerDraw += amt;
      } else {
        expenseByCategory[r._id.category] = amt;
        expense += amt;
      }
    });
    const net = round2(income - expense);
    const pctOfSpend = {};
    Object.entries(expenseByCategory).forEach(([k, v]) => { pctOfSpend[k] = pct(v, expense); });
    res.json({
      year: req.query.year ? Number(req.query.year) : 'all',
      income: round2(income), expense: round2(expense), net,
      margin: pct(net, income),
      ownerContribution: round2(ownerContribution),
      ownerDraw: round2(ownerDraw),
      incomeByCategory, expenseByCategory, pctOfSpend,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Canonical order-number key. Order.orderNumber is free-form ("0000021", "#21",
// "PO-021") and Transaction.orderNumber is stored digits-only but can still carry
// leading zeros ("0000021"). To line them up we strip EVERY non-digit AND any
// leading zeros, so "#0000021", "PO-021" and "21" all key to "21". An all-zeros
// or empty value normalizes to '' (no digits) — deliberately NOT collapsed to a
// shared "0" bucket that would merge every zero-ish row together.
//
// This is the SINGLE source of truth and is applied AT READ TIME on BOTH sides of
// every comparison (Order numbers and Transaction numbers alike), so grouping is
// fixed without rewriting stored data — see byOrder/byClient/the drill-in filter
// here and the CRM company-finance scoping (controllers/crm.js), which all route
// their keys through this. Exported for that reuse.
const normalizeOrderNumber = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');

// Pure per-company finance rollup — the SAME revenue/COGS/profit/margin
// definitions byOrder/byClient use, reusable from outside the finance routes
// (the CRM company page). No DB: callers pass the already-fetched POJOs.
//   • orders       — this company's Orders (need orderNumber, totalValue, paid)
//   • transactions — ledger rows to consider (the company's, by order number)
// Revenue = signed sum of income/'Customer Sales'; COGS = signed sum of
// expense rows in COGS_CATEGORIES; profit = revenue − COGS; margin = profit /
// revenue %. `signed` lets credits/returns net down, identical to the ledger.
//
// `outstanding` is the one figure the ledger has no notion of — it's
// invoiced-but-unpaid, which lives on the Order (paid flag + totalValue), not in
// the cash-basis Transaction stream. So it's summed from Orders: totalValue of
// every Order with paid !== true. orderCount/paidCount are plain Order tallies.
// Returns { revenue, cogs, profit, margin, outstanding, orderCount, paidCount }.
function summarizeCompanyFinance(orders, transactions) {
  const cogsCats = new Set(Transaction.COGS_CATEGORIES);
  let revenue = 0;
  let cogs = 0;
  for (const t of (transactions || [])) {
    if (t && t.type === 'income' && t.category === 'Customer Sales') revenue += signed(t);
    else if (t && t.type === 'expense' && cogsCats.has(t.category)) cogs += signed(t);
  }
  const profit = round2(revenue - cogs);

  let outstanding = 0;
  let orderCount = 0;
  let paidCount = 0;
  for (const o of (orders || [])) {
    if (!o) continue;
    orderCount += 1;
    if (o.paid) paidCount += 1;
    else outstanding += num(o.totalValue);   // invoiced (has a total) but not yet paid
  }

  return {
    revenue: round2(revenue),
    cogs: round2(cogs),
    profit,
    margin: pct(profit, revenue),
    outstanding: round2(outstanding),
    orderCount,
    paidCount,
  };
}

// THE per-order profit definition — the single rule byOrder, byClient and the
// drill-in detail all reconcile to. Given a set of ledger rows already scoped to
// ONE order: revenue = signed sum of income/'Customer Sales'; cost = signed sum
// of expense rows in COGS_CATEGORIES; profit = revenue − cost. Everything else
// tagged to the order (a Software expense, a stray non-COGS line, a non-Customer-
// Sales income) is intentionally OUT of profit — exactly as the byOrder/byClient
// rollups treat it. The drill-in mirrors this verbatim so its Profit equals the
// byOrder Profit row to the cent (its In/Out figures are a separate cash lens).
// Pure (no DB) so it's unit-testable and reusable. `signed` lets credits net down.
function orderRevenueCost(rows) {
  const cogsCats = new Set(Transaction.COGS_CATEGORIES);
  let revenue = 0;
  let cost = 0;
  for (const t of (rows || [])) {
    if (t && t.type === 'income' && t.category === 'Customer Sales') revenue += signed(t);
    else if (t && t.type === 'expense' && cogsCats.has(t.category)) cost += signed(t);
  }
  return { revenue: round2(revenue), cost: round2(cost), profit: round2(revenue - cost) };
}

// GET /api/finances/by-order?year=  — per-order P&L: revenue, cost, profit,
// margin %. An order's economics span time — the sale lands one day, the blanks
// and the printer invoice another, a reprint or trailing freight weeks later,
// sometimes across a year boundary. So we group an order across ALL its dates,
// net full revenue vs. full cost, and anchor it to the year it was SOLD (its
// first Customer Sales date). That stops a late-December order whose costs hit
// in January from showing up as a phantom loss in the new year.
const byOrder = async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const rows = await Transaction.find({ orderNumber: { $ne: '' } }).lean();
    const cogs = new Set(Transaction.COGS_CATEGORIES);
    const map = {};
    rows.forEach((t) => {
      // Group on the CANONICAL number (leading zeros stripped) so a "0000021" row
      // and a "21" row are the same order — not two split buckets on the drill-in.
      const key = normalizeOrderNumber(t.orderNumber);
      if (!key) return;
      const o = (map[key] ||= { orderNumber: key, client: '', revenue: 0, cost: 0, saleDate: null, firstDate: null });
      const d = t.date ? new Date(t.date) : null;
      if (d && (!o.firstDate || d < o.firstDate)) o.firstDate = d;
      if (t.type === 'income' && t.category === 'Customer Sales') {
        o.revenue += signed(t);   // a Customer-Sales credit = customer refund → nets revenue down
        if (!o.client) o.client = t.party;
        if (d && (!o.saleDate || d < o.saleDate)) o.saleDate = d;        // anchor = when it sold
      } else if (t.type === 'expense' && cogs.has(t.category)) {
        o.cost += signed(t);      // a COGS credit = supplier credit → nets cost down
      }
    });
    let orders = Object.values(map).map((o) => {
      const anchor = o.saleDate || o.firstDate;
      const profit = round2(o.revenue - o.cost);
      return {
        orderNumber: o.orderNumber, client: o.client,
        year: anchor ? new Date(anchor).getUTCFullYear() : null,
        revenue: round2(o.revenue), cost: round2(o.cost), profit,
        margin: pct(profit, o.revenue),
      };
    });
    orders = orders.filter((o) => o.revenue !== 0 || o.cost !== 0);  // real orders only (drop $0/$0 ghosts — an order# stuck on a software/overhead line)
    if (year) orders = orders.filter((o) => o.year === year);  // by the year it SOLD, not by cost dates
    orders.sort((a, b) => Number(b.orderNumber) - Number(a.orderNumber));
    res.json({ orders });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/finances/by-month?year=  — monthly income / expense / net, for the
// trend chart. Owner equity moves excluded (same as the P&L).
const byMonth = async (req, res) => {
  try {
    const yearMatch = yearDateMatch(req.query.year);
    const rows = await Transaction.aggregate([
      { $match: yearMatch },
      { $group: { _id: { y: { $year: '$date' }, m: { $month: '$date' }, type: '$type', category: '$category' }, total: { $sum: SIGNED_AMOUNT } } },
    ]);
    const map = {};
    rows.forEach((r) => {
      const key = `${r._id.y}-${String(r._id.m).padStart(2, '0')}`;
      const o = (map[key] ||= { month: key, income: 0, expense: 0 });
      const amt = round2(r.total);
      if (r._id.type === 'income') {
        // Mirror the P&L via the same contra-revenue rule: a 'Refund' nets DOWN
        // the month's income (money back to a customer); Owner Contribution is
        // equity → 0; everything else counts as-is.
        o.income += incomeContribution(r._id.category, amt);
      } else if (r._id.category !== 'Owner Draw') o.expense += amt;
    });
    const months = Object.values(map)
      .map((o) => ({ month: o.month, income: round2(o.income), expense: round2(o.expense), net: round2(o.income - o.expense) }))
      .sort((a, b) => a.month.localeCompare(b.month));
    res.json({ months });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/finances/by-client?year=  — profit rolled up per client across all
// their orders (anchored to the sale year, like by-order). The "who's actually
// worth the most to me" view.
const byClient = async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const rows = await Transaction.find({ orderNumber: { $ne: '' } }).lean();
    const cogs = new Set(Transaction.COGS_CATEGORIES);
    const orders = {};
    rows.forEach((t) => {
      // Same canonical grouping as byOrder so leading-zero variants of one order
      // number roll into a single order before we attribute it to a client.
      const key = normalizeOrderNumber(t.orderNumber);
      if (!key) return;
      const o = (orders[key] ||= { client: '', revenue: 0, cost: 0, saleDate: null, firstDate: null });
      const d = t.date ? new Date(t.date) : null;
      if (d && (!o.firstDate || d < o.firstDate)) o.firstDate = d;
      if (t.type === 'income' && t.category === 'Customer Sales') {
        o.revenue += signed(t); if (!o.client) o.client = t.party;
        if (d && (!o.saleDate || d < o.saleDate)) o.saleDate = d;
      } else if (t.type === 'expense' && cogs.has(t.category)) o.cost += signed(t);
    });
    const byC = {};
    Object.values(orders).forEach((o) => {
      const anchor = o.saleDate || o.firstDate;
      const oy = anchor ? new Date(anchor).getUTCFullYear() : null;
      if (year && oy !== year) return;
      if (o.revenue === 0 && o.cost === 0) return;             // skip $0/$0 ghosts (order# on a non-COGS line)
      const name = ((o.client || '').trim()) || '—';
      const c = (byC[name] ||= { client: name, revenue: 0, cost: 0, orders: 0 });
      c.revenue += o.revenue; c.cost += o.cost; c.orders += 1;
    });
    const clients = Object.values(byC).map((c) => {
      const profit = round2(c.revenue - c.cost);
      return { client: c.client, orders: c.orders, revenue: round2(c.revenue), cost: round2(c.cost), profit, margin: pct(profit, c.revenue) };
    }).sort((a, b) => b.profit - a.profit);
    res.json({ clients });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/finances/export?year=  — CSV download of the ledger.
const exportCsv = async (req, res) => {
  try {
    const q = yearDateMatch(req.query.year);
    const txns = await Transaction.find(q).sort({ date: 1 }).lean();
    const header = ['Date', 'Type', 'Category', 'Order #', 'Customer/Vendor', 'Description', 'Amount', 'QB Synced'];
    const lines = [header.join(',')];
    txns.forEach((t) => lines.push([
      new Date(t.date).toISOString().slice(0, 10),
      t.type === 'income' ? 'Income' : 'Expense',
      t.category, t.orderNumber, t.party, t.description,
      // Credits export as a negative amount so a re-import re-flags them.
      round2(signed(t)), t.qbSynced ? 'Yes' : 'No',
    ].map(csvCell).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="JP-Ledger-${req.query.year || 'all'}.csv"`);
    res.send(lines.join('\n'));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// One-time repair: re-derive `year` from `date` for any row where they drifted
// (e.g. a date edited via findByIdAndUpdate before the update-hook existed).
// Safe + idempotent — only corrects the denormalized filter field, never touches
// amounts, dates, or categories. Run on boot; after the first pass it's a no-op.
const resyncYears = async () => {
  const rows = await Transaction.find({}, 'date year').lean();
  let fixed = 0;
  for (const r of rows) {
    if (!r.date) continue;
    const y = new Date(r.date).getUTCFullYear();
    if (r.year !== y) { await Transaction.updateOne({ _id: r._id }, { $set: { year: y } }); fixed++; }
  }
  return fixed;
};

module.exports = { importCsv, list, create, update, remove, summary, byOrder, byMonth, byClient, exportCsv, resyncYears };
// Reusable, DB-free finance math for other surfaces (CRM company page) + tests.
module.exports.summarizeCompanyFinance = summarizeCompanyFinance;
module.exports.normalizeOrderNumber = normalizeOrderNumber;
module.exports.orderRevenueCost = orderRevenueCost;
module.exports.pct = pct;
module.exports.signed = signed;
module.exports.incomeContribution = incomeContribution;
