// Finance tracker — the clean ledger + analytics that replace the manual
// spreadsheet and the QuickBooks re-keying. Source of truth is the DB; the
// owner keeps an owned copy via CSV export (downloaded on demand at tax time —
// not auto-emailed). Income vs expense is explicit; COGS links to orders for
// per-order and per-client margin. Admin-only.

const Transaction = require('../models/Transaction');
const r2 = require('../services/r2');

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

// Parties whose income isn't merch (e.g. VT3D — a service gig with no COGS).
// It stays in the raw ledger AND the tax CSV (the accountant counts it as
// income), but is pulled OUT of every internal view so the P&L, margins, and
// client ranking reflect the REAL merch business. One regex for now; promote to
// a setting/UI when there's a second one.
const NON_MERCH_RE = /vt3d/i;
const isNonMerch = (party) => NON_MERCH_RE.test(String(party || ''));

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
      const amount = Math.abs(num(c[ix.amount]));
      if (isNaN(date.getTime()) || !amount) continue;
      docs.push({
        date,
        type: /income/i.test(c[ix.type]) ? 'income' : 'expense',
        category: (c[ix.category] || 'Other').trim(),
        orderNumber: String(c[ix.order] || '').replace(/[^0-9]/g, ''),
        party: (c[ix.party] || '').trim(),
        description: (c[ix.desc] || '').trim(),
        amount,
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
    if (req.query.orderNumber) q.orderNumber = String(req.query.orderNumber).replace(/[^0-9]/g, '');
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
    // Merch P&L excludes non-merch parties (VT3D); they're reported on the side.
    const rows = await Transaction.aggregate([
      { $match: { ...yearMatch, party: { $not: NON_MERCH_RE } } },
      { $group: { _id: { type: '$type', category: '$category' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    // Non-merch income/expense — out of the P&L above, kept in the tax export.
    const nmRows = await Transaction.aggregate([
      { $match: { ...yearMatch, party: NON_MERCH_RE } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]);
    let nonMerchIncome = 0, nonMerchExpense = 0;
    nmRows.forEach((r) => { if (r._id === 'income') nonMerchIncome = round2(r.total); else nonMerchExpense = round2(r.total); });
    let income = 0, expense = 0, ownerContribution = 0, ownerDraw = 0;
    const expenseByCategory = {}, incomeByCategory = {};
    rows.forEach((r) => {
      const amt = round2(r.total);
      if (r._id.type === 'income') {
        incomeByCategory[r._id.category] = amt;
        // Owner Contribution is equity IN — not earnings.
        if (r._id.category === 'Owner Contribution') ownerContribution += amt;
        else income += amt;
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
    Object.entries(expenseByCategory).forEach(([k, v]) => { pctOfSpend[k] = expense ? round2((v / expense) * 100) : 0; });
    res.json({
      year: req.query.year ? Number(req.query.year) : 'all',
      income: round2(income), expense: round2(expense), net,
      margin: income ? round2((net / income) * 100) : 0,
      ownerContribution: round2(ownerContribution),
      ownerDraw: round2(ownerDraw),
      nonMerch: { income: nonMerchIncome, expense: nonMerchExpense, net: round2(nonMerchIncome - nonMerchExpense), label: 'VT3D' },
      incomeByCategory, expenseByCategory, pctOfSpend,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

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
      const o = (map[t.orderNumber] ||= { orderNumber: t.orderNumber, client: '', revenue: 0, cost: 0, saleDate: null, firstDate: null });
      const d = t.date ? new Date(t.date) : null;
      if (d && (!o.firstDate || d < o.firstDate)) o.firstDate = d;
      if (t.type === 'income' && t.category === 'Customer Sales') {
        o.revenue += t.amount;
        if (!o.client) o.client = t.party;
        if (d && (!o.saleDate || d < o.saleDate)) o.saleDate = d;        // anchor = when it sold
      } else if (t.type === 'expense' && cogs.has(t.category)) {
        o.cost += t.amount;
      }
    });
    let orders = Object.values(map).map((o) => {
      const anchor = o.saleDate || o.firstDate;
      const profit = round2(o.revenue - o.cost);
      return {
        orderNumber: o.orderNumber, client: o.client,
        year: anchor ? new Date(anchor).getUTCFullYear() : null,
        revenue: round2(o.revenue), cost: round2(o.cost), profit,
        margin: o.revenue ? round2((profit / o.revenue) * 100) : 0,
      };
    });
    orders = orders.filter((o) => !isNonMerch(o.client) && (o.revenue !== 0 || o.cost !== 0));  // merch orders with real activity (drop $0/$0 ghosts — an order# stuck on a software/overhead line)
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
      { $match: { ...yearMatch, party: { $not: NON_MERCH_RE } } },   // merch trend only
      { $group: { _id: { y: { $year: '$date' }, m: { $month: '$date' }, type: '$type', category: '$category' }, total: { $sum: '$amount' } } },
    ]);
    const map = {};
    rows.forEach((r) => {
      const key = `${r._id.y}-${String(r._id.m).padStart(2, '0')}`;
      const o = (map[key] ||= { month: key, income: 0, expense: 0 });
      const amt = round2(r.total);
      if (r._id.type === 'income') { if (r._id.category !== 'Owner Contribution') o.income += amt; }
      else if (r._id.category !== 'Owner Draw') o.expense += amt;
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
      const o = (orders[t.orderNumber] ||= { client: '', revenue: 0, cost: 0, saleDate: null, firstDate: null });
      const d = t.date ? new Date(t.date) : null;
      if (d && (!o.firstDate || d < o.firstDate)) o.firstDate = d;
      if (t.type === 'income' && t.category === 'Customer Sales') {
        o.revenue += t.amount; if (!o.client) o.client = t.party;
        if (d && (!o.saleDate || d < o.saleDate)) o.saleDate = d;
      } else if (t.type === 'expense' && cogs.has(t.category)) o.cost += t.amount;
    });
    const byC = {};
    Object.values(orders).forEach((o) => {
      const anchor = o.saleDate || o.firstDate;
      const oy = anchor ? new Date(anchor).getUTCFullYear() : null;
      if (year && oy !== year) return;
      if (isNonMerch(o.client)) return;                        // merch clients only (VT3D excluded internally)
      if (o.revenue === 0 && o.cost === 0) return;             // skip $0/$0 ghosts (order# on a non-COGS line)
      const name = ((o.client || '').trim()) || '—';
      const c = (byC[name] ||= { client: name, revenue: 0, cost: 0, orders: 0 });
      c.revenue += o.revenue; c.cost += o.cost; c.orders += 1;
    });
    const clients = Object.values(byC).map((c) => {
      const profit = round2(c.revenue - c.cost);
      return { client: c.client, orders: c.orders, revenue: round2(c.revenue), cost: round2(c.cost), profit, margin: c.revenue ? round2((profit / c.revenue) * 100) : 0 };
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
      t.category, t.orderNumber, t.party, t.description, round2(t.amount), t.qbSynced ? 'Yes' : 'No',
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
