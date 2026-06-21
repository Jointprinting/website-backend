// Finance tracker — the clean ledger + analytics that replace the manual
// spreadsheet and the QuickBooks re-keying. Source of truth is the DB; the
// owner keeps an owned copy via CSV export (and the app emails it on a
// schedule). Income vs expense is explicit; COGS links to orders for per-order
// and per-client margin. Admin-only.

const Transaction = require('../models/Transaction');
const r2 = require('../services/r2');

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

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
    const q = {};
    if (req.query.year) q.year = Number(req.query.year);
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
    const t = await Transaction.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!t) return res.status(404).json({ message: 'Not found' });
    res.json({ transaction: t });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
const remove = async (req, res) => {
  try { await Transaction.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ message: e.message }); }
};

// GET /api/finances/summary?year=  — the P&L: income, expense-by-category, net,
// %-of-spend per category. Owner Contribution is income but excluded from profit
// (it's equity in, not earnings).
const summary = async (req, res) => {
  try {
    const match = req.query.year ? { year: Number(req.query.year) } : {};
    const rows = await Transaction.aggregate([
      { $match: match },
      { $group: { _id: { type: '$type', category: '$category' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    let income = 0, expense = 0, ownerContribution = 0;
    const expenseByCategory = {}, incomeByCategory = {};
    rows.forEach((r) => {
      const amt = round2(r.total);
      if (r._id.type === 'income') {
        incomeByCategory[r._id.category] = amt;
        if (r._id.category === 'Owner Contribution') ownerContribution += amt;
        else income += amt;
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
      incomeByCategory, expenseByCategory, pctOfSpend,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/finances/by-order?year=  — per-order P&L: revenue, cost, profit,
// margin %. Cost = COGS-category expenses sharing the order #.
const byOrder = async (req, res) => {
  try {
    const match = { orderNumber: { $ne: '' } };
    if (req.query.year) match.year = Number(req.query.year);
    const rows = await Transaction.find(match).lean();
    const cogs = new Set(Transaction.COGS_CATEGORIES);
    const map = {};
    rows.forEach((t) => {
      const o = (map[t.orderNumber] ||= { orderNumber: t.orderNumber, client: '', revenue: 0, cost: 0 });
      if (t.type === 'income' && t.category === 'Customer Sales') { o.revenue += t.amount; if (!o.client) o.client = t.party; }
      else if (t.type === 'expense' && cogs.has(t.category)) o.cost += t.amount;
    });
    const orders = Object.values(map).map((o) => {
      const profit = round2(o.revenue - o.cost);
      return { ...o, revenue: round2(o.revenue), cost: round2(o.cost), profit, margin: o.revenue ? round2((profit / o.revenue) * 100) : 0 };
    }).sort((a, b) => Number(b.orderNumber) - Number(a.orderNumber));
    res.json({ orders });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/finances/export?year=  — CSV download of the ledger.
const exportCsv = async (req, res) => {
  try {
    const q = req.query.year ? { year: Number(req.query.year) } : {};
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

module.exports = { importCsv, list, create, update, remove, summary, byOrder, exportCsv };
