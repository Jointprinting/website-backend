// Finance tracker — the clean ledger + analytics that replace the manual
// spreadsheet and the QuickBooks re-keying. Source of truth is the DB; the
// owner keeps an owned copy via CSV export (downloaded on demand at tax time —
// not auto-emailed). Income vs expense is explicit; COGS links to orders for
// per-order and per-client margin. Admin-only.

const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const PurchaseOrder = require('../models/PurchaseOrder');
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

// What ONE income row contributes to a SPECIFIC order's / client's revenue — the
// single rule that makes per-order/per-client revenue reconcile to the headline
// P&L, fixing the "numbers feel wrong" bug. The headline already nets a customer
// refund DOWN (incomeContribution: a 'Refund' row → −|amount|; a 'Customer Sales'
// credit → −amount). But byOrder/byClient/summarizeCompanyFinance/paymentGaps used
// to count revenue as STRICTLY income·'Customer Sales', so a refund booked under the
// 'Refund' category lowered the top-line yet left the refunded order at full profit
// — they never reconciled. Now an order's revenue counts BOTH consistent forms of a
// refund as contra-revenue, IDENTICAL to the headline:
//   • 'Customer Sales'           → signed(t)            (a Customer-Sales CREDIT nets down)
//   • 'Refund'                   → −|signed(t)|         (always reduces, never inflates —
//                                                        same as incomeContribution)
//   • anything else (Other / Owner Contribution / a stray income line) → 0
//                                  (never was order revenue; deliberately excluded so a
//                                   normal order with ONLY Customer-Sales rows is 100%
//                                   unchanged — the safety guarantee).
// Pure + exported so the contra-revenue rule is unit-testable and reused everywhere.
function orderRevenueContribution(t) {
  if (!t || t.type !== 'income') return 0;
  if (t.category === 'Customer Sales') return signed(t);
  if (t.category === 'Refund') return -Math.abs(signed(t)) + 0;   // + 0 normalizes -0 to 0
  return 0;
}

// ── processing fee (merchant fee on a client payment) ───────────────────────
// Resolve the fee RATE (a fraction of the payment) for a payment method. CC/ACH
// use the owner-overridable defaults on the model; an explicit numeric `override`
// (fraction, e.g. 0.025) always wins so the owner can set their real rate. 'none'/
// blank/unknown → 0 (no fee). Clamped to [0, 1) so a bad override can't ever book
// a fee larger than the payment. Pure + exported for tests.
function processingFeeRate(method, override) {
  const key = String(method || '').toLowerCase();
  // 'none'/blank/unknown method = no fee, FULL STOP — a stale override never
  // resurrects a fee the owner waived (the method is the on/off switch).
  if (key !== 'cc' && key !== 'ach') return 0;
  if (override != null && override !== '') {
    const r = num(override);
    return Number.isFinite(r) && r > 0 ? Math.min(r, 0.9999) : 0;
  }
  const rates = Transaction.PROCESSING_FEE_RATES || {};
  const r = num(rates[key]);
  return Number.isFinite(r) && r > 0 ? Math.min(r, 0.9999) : 0;
}

// The fee AMOUNT a processor takes out of a payment = round2(amount × rate). Only a
// real client payment (income · Customer Sales, NOT a credit/refund) is charged a
// fee — a refund or a non-sale income row returns 0. Pure + exported for tests.
function computeProcessingFee(paymentTxn, method, override) {
  const t = paymentTxn || {};
  if (t.type !== 'income' || t.category !== 'Customer Sales' || t.isCredit) return 0;
  const amt = Math.abs(num(t.amount));
  if (!amt) return 0;
  const rate = processingFeeRate(method, override);
  if (!rate) return 0;
  return round2(amt * rate);
}

// Build the linked Processing Fee EXPENSE doc for a saved payment row (or null when
// no fee applies). Same order #, party, date and (canonical) details as the payment
// so it rolls into the SAME order's COGS and reconciles. `feeForTxn` links it back
// to the payment _id so it stays idempotent (one fee per payment, replace-not-stack).
// Pure (no DB) + exported for tests — the async sync below just persists it.
function buildProcessingFeeDoc(paymentTxn, method, override) {
  const fee = computeProcessingFee(paymentTxn, method, override);
  if (!fee) return null;
  const t = paymentTxn || {};
  const m = String(method || '').toLowerCase();
  const label = m === 'cc' ? 'Credit card' : m === 'ach' ? 'ACH' : 'Card';
  return {
    date: t.date,
    type: 'expense',
    category: 'Processing Fee',
    orderNumber: t.orderNumber || '',
    party: t.party || '',
    description: `${label} processing fee${t.orderNumber ? ` — order #${t.orderNumber}` : ''}`,
    amount: fee,
    isCredit: false,
    paymentMethod: m,
    feeForTxn: String(t._id || ''),
    source: 'fee:auto',
  };
}

// Persist (create / replace / remove) the auto Processing Fee for a payment row.
// IDEMPOTENT and race-safe: keyed on { feeForTxn, source:'fee:auto' }, there is
// AT MOST ONE auto-fee per payment.
//   • a fee applies  → upsert (findOneAndUpdate, upsert:true) that single row, so a
//                      changed amount/method/rate updates it in place — two racing
//                      saves converge on one row instead of stacking duplicates;
//   • no fee applies → delete it (method switched to 'none', amount cleared, or the
//                      row is no longer a client payment).
// A manually-entered Processing Fee (no feeForTxn link) is never matched, so it's
// never touched. No-op unless the row is a real client payment with an _id.
async function syncProcessingFee(paymentTxn, method, override) {
  const t = paymentTxn || {};
  if (!t._id) return;
  const filter = { feeForTxn: String(t._id), source: 'fee:auto' };
  const doc = buildProcessingFeeDoc(t, method, override);
  if (doc) {
    // Replace-in-place (or create). Upsert on the unique link makes concurrent saves
    // converge on ONE row; the older delete-then-insert could briefly stack two.
    await Transaction.findOneAndUpdate(filter, { $set: doc }, { upsert: true, new: true });
    // Belt-and-suspenders: if a prior bug ever left duplicates, collapse them to the
    // one we just upserted (cheap, idempotent — normally matches nothing).
    const dupes = await Transaction.find(filter).select('_id').sort({ _id: 1 }).lean();
    if (dupes.length > 1) {
      await Transaction.deleteMany({ _id: { $in: dupes.slice(1).map((d) => d._id) } });
    }
  } else {
    // No fee now applies → remove any existing linked auto-fee.
    await Transaction.deleteMany(filter);
  }
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

// Income-looking categories — used to recover a CSV row's DIRECTION when the Type
// column is blank/unrecognized (a QuickBooks-style export often omits it). Lower-cased.
const INCOME_CATS = new Set(['customer sales', 'refund', 'owner contribution']);

// Decide income vs expense for an imported row. An explicit Type cell ("Income"/
// "Expense") always wins; otherwise INFER from the category so a typeless refund or
// sale row (negative or positive) isn't silently dropped into 'expense' (the bug a
// QuickBooks refund import would otherwise hit). Default 'expense' only for genuinely
// ambiguous rows — most ledger lines are costs. `isCredit` is decided separately from
// the amount sign, so a NEGATIVE 'Customer Sales'/'Refund' row → income + credit =
// a customer refund that correctly nets revenue down. Pure + exported for tests.
function inferRowType(typeCell, category) {
  const tc = String(typeCell || '');
  if (/income/i.test(tc)) return 'income';
  if (/expense/i.test(tc)) return 'expense';
  return INCOME_CATS.has(String(category || '').trim().toLowerCase()) ? 'income' : 'expense';
}

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
      const date = ix.date >= 0 ? new Date(c[ix.date]) : new Date('');
      const rawAmount = num(c[ix.amount]);
      const amount = Math.abs(rawAmount);
      if (isNaN(date.getTime()) || !amount) continue;   // skip undated / zero-amount rows
      const category = String(c[ix.category] || 'Other').trim() || 'Other';
      docs.push({
        date,
        type: inferRowType(c[ix.type], category),       // explicit Type wins; else infer from category
        category,
        orderNumber: String(c[ix.order] || '').replace(/[^0-9]/g, ''),
        party: String(c[ix.party] || '').trim(),
        description: String(c[ix.desc] || '').trim(),
        amount,
        isCredit: rawAmount < 0,   // a negative ledger amount = a credit / return
        qbSynced: /yes/i.test(String(c[ix.qb] || '')),
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
    // Payment-method tagging drives the auto Processing Fee. An optional `feeRate`
    // (fraction) overrides the CC/ACH default; we PERSIST it on the payment row (as
    // feeRateOverride) so a later edit re-rates at the owner's rate, not the default.
    if (body.feeRate != null && body.feeRate !== '') body.feeRateOverride = num(body.feeRate);
    delete body.feeRate;
    if (dataUrl && r2.isR2Configured()) {
      const m = String(dataUrl).match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
      if (m) body.receiptUrl = await r2.uploadBuffer(Buffer.from(m[2], 'base64'), m[1].toLowerCase(), 'receipts');
    }
    if (body.amount != null) body.amount = Math.abs(num(body.amount));
    const txn = await Transaction.create(body);
    // Auto-book the merchant fee as a linked Processing Fee expense on the SAME
    // order (only when this is a real client payment with a CC/ACH method). Reads
    // method + override from the saved row, so the persisted values are the source.
    await syncProcessingFee(txn, txn.paymentMethod, txn.feeRateOverride);
    res.json({ transaction: txn });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
const update = async (req, res) => {
  try {
    const body = { ...req.body };
    // Allow attaching (or replacing) a receipt on an existing entry later.
    const dataUrl = body.receiptDataUrl; delete body.receiptDataUrl;
    // A re-sent feeRate persists as the new override; if absent we DON'T clear the
    // stored one (so an unrelated edit keeps the owner's negotiated rate).
    if (body.feeRate != null && body.feeRate !== '') body.feeRateOverride = num(body.feeRate);
    delete body.feeRate;
    if (dataUrl && r2.isR2Configured()) {
      const m = String(dataUrl).match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
      if (m) body.receiptUrl = await r2.uploadBuffer(Buffer.from(m[2], 'base64'), m[1].toLowerCase(), 'receipts');
    }
    if (body.amount != null) body.amount = Math.abs(num(body.amount));
    const t = await Transaction.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true });
    if (!t) return res.status(404).json({ message: 'Not found' });
    // Re-sync the linked Processing Fee from the UPDATED payment (replace-not-stack):
    // a changed amount/method updates the single fee row; switching to 'none' clears
    // it. method + override are read from the SAVED row, so an edit that doesn't
    // resend them still re-rates at the persisted rate (not the default). Never
    // touches a manual (unlinked) fee row.
    await syncProcessingFee(t, t.paymentMethod, t.feeRateOverride);
    res.json({ transaction: t });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
const remove = async (req, res) => {
  try {
    await Transaction.findByIdAndDelete(req.params.id);
    // Tidy up: delete any auto Processing Fee that was linked to this payment, so a
    // removed payment doesn't leave an orphan fee expense skewing the order's cost.
    await Transaction.deleteMany({ feeForTxn: String(req.params.id), source: 'fee:auto' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
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
      if (!r || !r._id) return;                          // defensive: skip a malformed group
      // Coerce a missing/null/blank category to 'Other' and a non-finite total to 0
      // so one dirty row can never poison a whole bucket or surface a `null` key.
      const cat = (r._id.category == null || r._id.category === '') ? 'Other' : String(r._id.category);
      r._id.category = cat;
      const amt = round2(r.total);
      if (r._id.type === 'income') {
        if (cat === 'Owner Contribution') {
          // Equity IN, not earnings — reported on the side, never in income. Its
          // breakdown row shows the real amount contributed.
          incomeByCategory[cat] = round2((incomeByCategory[cat] || 0) + amt);
          ownerContribution += amt;
        } else {
          // Contra-revenue rule: a 'Refund' nets DOWN income (the audit's inflate
          // bug); everything else counts as-is. The breakdown stores the SAME
          // contribution, so a refund shows as a negative that matches the headline.
          // We ACCUMULATE into the bucket (not overwrite) so a coerced-to-'Other'
          // null-category group can't clobber a real 'Other' group's subtotal.
          const contrib = incomeContribution(cat, amt);
          incomeByCategory[cat] = round2((incomeByCategory[cat] || 0) + contrib);
          income += contrib;
        }
      } else if (cat === 'Owner Draw') {
        // Owner Draw is equity OUT (the owner paying themselves) — NOT a cost of
        // doing business. Must not count against profit or show up as "spend".
        ownerDraw += amt;
      } else {
        expenseByCategory[cat] = round2((expenseByCategory[cat] || 0) + amt);
        expense += amt;
      }
    });
    const net = round2(income - expense);
    const pctOfSpend = {};
    Object.entries(expenseByCategory).forEach(([k, v]) => { pctOfSpend[k] = pct(v, expense); });
    // Owner cash lens (additive — does NOT change the profit definition). Profit
    // stays draw-EXCLUDED (a draw is a distribution of earned profit, not a cost,
    // and an LLC/sole-prop is taxed on profit, not draws). On top of that we show:
    //   • takeHome       = what the owner actually paid themselves this period (Σ
    //                      Owner Draw, already separated above) — the cash out.
    //   • leftInBusiness = profit retained AFTER that draw (net − draw). Negative
    //                      means the owner drew more than the business earned this
    //                      period (drawing into prior cash) — a real signal to see.
    // Owner Contribution (equity IN) is intentionally NOT added back here: this is
    // "of the profit I earned, how much did I keep vs take", not a cash-flow stmt.
    const takeHome = round2(ownerDraw);
    const leftInBusiness = round2(net - ownerDraw);
    res.json({
      year: req.query.year ? Number(req.query.year) : 'all',
      income: round2(income), expense: round2(expense), net,
      margin: pct(net, income),
      ownerContribution: round2(ownerContribution),
      ownerDraw: round2(ownerDraw),
      takeHome, leftInBusiness,
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
  let cogs = 0;                 // ACTUAL cost — from the receipts/expense ledger
  let receiptCount = 0;         // COGS rows that carry a stored receipt file
  for (const t of (transactions || [])) {
    if (t && t.type === 'income') revenue += orderRevenueContribution(t);   // Customer Sales + Refund contra (headline-consistent)
    else if (t && t.type === 'expense' && cogsCats.has(t.category)) {
      cogs += signed(t);
      if (t.receiptUrl) receiptCount += 1;
    }
  }
  const profit = round2(revenue - cogs);   // profit is on the ACTUAL (receipt) cost

  let outstanding = 0;
  let orderCount = 0;
  let paidCount = 0;
  let estimatedCogs = 0;        // the confirmation/quote estimate, summed off Orders
  for (const o of (orders || [])) {
    if (!o) continue;
    orderCount += 1;
    if (o.paid) paidCount += 1;
    else outstanding += num(o.totalValue);   // invoiced (has a total) but not yet paid
    estimatedCogs += num(o.cogs);            // each Order's stored estimate (quote/confirmation)
  }

  return {
    revenue: round2(revenue),
    cogs: round2(cogs),                      // ACTUAL (receipts) — the headline cost
    estimatedCogs: round2(estimatedCogs),    // ESTIMATE (confirmation) — shown alongside
    profit,
    margin: pct(profit, revenue),
    outstanding: round2(outstanding),
    orderCount,
    paidCount,
    receiptCount,                            // how much of the cost is receipt-backed
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
    if (t && t.type === 'income') revenue += orderRevenueContribution(t);   // Customer Sales + Refund contra (headline-consistent)
    else if (t && t.type === 'expense' && cogsCats.has(t.category)) cost += signed(t);
  }
  return { revenue: round2(revenue), cost: round2(cost), profit: round2(revenue - cost) };
}

// The ACTUAL cost of an order, straight from the receipts/expense ledger. Given
// ledger rows already scoped to ONE order, cost = signed sum of expense rows in
// COGS_CATEGORIES — the SAME definition orderRevenueCost/byOrder use for `cost`,
// so the "actual" an order/project shows always reconciles to the finance ledger.
// `receiptCount` counts the COGS rows that carry a stored receipt file (the proof
// behind the number); `hasReceipts` is whether ANY cost receipt is linked yet, so
// a missing-receipt order is flaggable. Pure (no DB) + exported for reuse + tests.
function orderActualCost(rows) {
  const cogsCats = new Set(Transaction.COGS_CATEGORIES);
  let cost = 0;
  let cogsLines = 0;
  let receiptCount = 0;
  for (const t of (rows || [])) {
    if (t && t.type === 'expense' && cogsCats.has(t.category)) {
      cost += signed(t);
      cogsLines += 1;
      if (t.receiptUrl) receiptCount += 1;
    }
  }
  return { actualCost: round2(cost), cogsLines, receiptCount, hasReceipts: receiptCount > 0 };
}

// Build a map of canonical-order-number → actual-cost summary from a flat list of
// ledger rows (each carrying an orderNumber). Keys via normalizeOrderNumber so a
// "0000021" row and a "21" row land in the SAME order bucket (leading-zero-safe,
// the C2 fix). Used to attach receipt-derived ACTUAL cost to orders/projects
// without re-querying per order. Pure (no DB) + exported for reuse + tests.
function actualCostByOrder(transactions) {
  const buckets = {};
  for (const t of (transactions || [])) {
    const key = normalizeOrderNumber(t && t.orderNumber);
    if (!key) continue;
    (buckets[key] ||= []).push(t);
  }
  const out = {};
  for (const [key, rows] of Object.entries(buckets)) out[key] = orderActualCost(rows);
  return out;
}

// ── revenue gap: billed vs collected vs cost (why profit looks too low) ───────
// PURE per-order gap analysis (no DB) — surfaces the money that's missing because
// vendor COST receipts were entered but the matching CLIENT PAYMENT income wasn't.
// For each Order it lines up three figures, all on the SAME definitions the P&L
// uses (so this never re-derives profit, only explains a gap):
//   • billed    = what the client was charged = Order.totalValue (the confirmation
//                 grand total — the order is the source of truth for the invoice).
//   • collected = Σ signed income/'Customer Sales' transactions linked to the order
//                 (the cash actually recorded as received — same revenue rule as
//                 byOrder/summarizeCompanyFinance; a customer-refund credit nets down).
//   • cost      = Σ signed COGS expense transactions = orderActualCost.actualCost
//                 (the actual money spent producing it; a supplier credit nets down).
// Transactions are matched to Orders by normalizeOrderNumber (leading-zero safe),
// the SAME canonical key everywhere else. Two gap signals per order:
//   • costWithoutPayment — cost > 0 but collected === 0: a job we paid to produce
//     with NO recorded client payment. The loudest flag (this is what's hiding the
//     real profit — costs in, the income not yet entered).
//   • outstanding — billed > 0 and collected < billed: invoiced but not (fully)
//     collected = max(billed − collected, 0).
// Only orders WITH a gap are returned (a fully-collected order isn't clutter).
// Pure + exported for reuse + tests; the endpoint adds the year anchoring.
function paymentGapsForOrders(orders, transactions) {
  const byKey = {};
  for (const t of (transactions || [])) {
    const k = normalizeOrderNumber(t && t.orderNumber);
    if (!k) continue;                       // a row with no order# can't be linked
    (byKey[k] ||= []).push(t);
  }
  const rows = [];
  let costWithoutPayment = 0;
  let costWithoutPaymentCount = 0;
  let billedNotCollected = 0;

  for (const o of (orders || [])) {
    if (!o) continue;
    const key = normalizeOrderNumber(o.orderNumber);
    if (!key) continue;                     // an order with no number can't be matched
    const linked = byKey[key] || [];
    let collected = 0;
    for (const t of linked) {
      // Net cash collected from the client: Customer-Sales payments, LESS any
      // refund (a 'Refund' row OR a Customer-Sales credit) — the same contra rule
      // as the headline, so a refunded order's "collected" matches its revenue.
      if (t && t.type === 'income') collected += orderRevenueContribution(t);
    }
    collected = round2(collected);
    const cost = orderActualCost(linked).actualCost;   // signed COGS — reused, not re-derived
    const billed = round2(num(o.totalValue));
    const client = (String(o.companyName == null ? '' : o.companyName).trim()) || (String(o.clientName == null ? '' : o.clientName).trim()) || '—';

    // "Cost recorded but no payment": cost > 0 and NO positive payment collected.
    // Tested as collected <= 0 (not === 0) so a customer CREDIT that nets collected
    // negative (a refund with no offsetting payment) still counts as unpaid rather
    // than silently suppressing the flag and dropping the order from the report.
    const noPayment = cost > 0 && collected <= 0;
    const outstanding = round2(Math.max(billed - collected, 0));

    if (noPayment) { costWithoutPayment = round2(costWithoutPayment + cost); costWithoutPaymentCount += 1; }
    if (billed > 0 && outstanding > 0) billedNotCollected = round2(billedNotCollected + outstanding);

    if (noPayment || (billed > 0 && outstanding > 0)) {
      rows.push({
        orderNumber: key, client, billed, collected, cost,
        outstanding, costWithoutPayment: noPayment, paid: !!o.paid,
      });
    }
  }
  // Loudest first: cost-without-payment, then biggest outstanding, then newest #.
  rows.sort((a, b) =>
    (Number(b.costWithoutPayment) - Number(a.costWithoutPayment)) ||
    (b.outstanding - a.outstanding) ||
    (Number(b.orderNumber) - Number(a.orderNumber)));

  return {
    orders: rows,
    totals: {
      costWithoutPayment: round2(costWithoutPayment),
      costWithoutPaymentCount,
      billedNotCollected: round2(billedNotCollected),
    },
  };
}

// ── missing receipts: "did I forget to enter a cost receipt?" ─────────────────
// The owner's rule: an order doesn't really start until he's paid, and once it's
// in progress he needs to have entered its cost receipts. This flags an active
// in-progress order missing one of the COGS receipts it's EXPECTED to have. The
// three receipt types map to ledger COGS categories:
//   • Printer COGS — always expected (every job has a printer).
//   • Blank COGS   — expected only when JP SOURCED the blanks. A PO with
//     blanksProvided===true means JP supplied the garments (bought separately, so
//     a blanks receipt exists); false means the printer used their own blanks (no
//     separate receipt). With no POs yet, assume JP supplies them — the ~99%
//     default the PO seeder already uses.
//   • Shipping     — expected only when the order actually carried freight
//     (shippingCost > 0); a local / pickup / bundled job is never nagged.
// All three pieces are PURE (no DB) + exported for reuse and tests.
const RECEIPT_COGS = ['Printer COGS', 'Blank COGS', 'Shipping'];
const RECEIPT_LABEL = { 'Printer COGS': 'printer', 'Blank COGS': 'blanks', 'Shipping': 'shipping' };
// Production statuses that (with `paid`) mark an order "in progress" — money
// committed, work underway, but NOT wrapped. 'delivered'/'cancelled' are done and
// deliberately excluded so the list stays current instead of re-auditing history.
const IN_PROGRESS_STATUSES = ['placed', 'in_production', 'shipped'];

function orderInProgress(o) {
  if (!o) return false;
  if (o.status === 'cancelled' || o.status === 'delivered') return false;
  return o.paid === true || IN_PROGRESS_STATUSES.includes(o.status);
}

function expectedReceiptCats(order, pos) {
  const expected = ['Printer COGS'];
  const list = (pos || []).filter(Boolean);
  // JP sourced blanks ⇒ expect a blanks receipt. If any PO marks JP-supplied, or
  // there are no POs yet (the seeder's ~99% default), expect blanks.
  const blanksExpected = list.length ? list.some((p) => p.blanksProvided === true) : true;
  if (blanksExpected) expected.push('Blank COGS');
  if (num(order && order.shippingCost) > 0) expected.push('Shipping');
  return expected;
}

function presentReceiptCats(rows) {
  const present = new Set();
  for (const t of (rows || [])) {
    if (t && t.type === 'expense' && RECEIPT_COGS.includes(t.category)) present.add(t.category);
  }
  return present;
}

// PURE: in-progress orders missing an expected receipt. `posByKey` maps canonical
// orderNumber → that order's (non-archived) POs, for the blanks rule. Returns one
// row per flagged order naming the specific missing type(s), newest order # first.
function missingReceiptsForOrders(orders, transactions, posByKey) {
  const byKey = {};
  for (const t of (transactions || [])) {
    const k = normalizeOrderNumber(t && t.orderNumber);
    if (!k) continue;
    (byKey[k] ||= []).push(t);
  }
  const rows = [];
  for (const o of (orders || [])) {
    if (!orderInProgress(o)) continue;
    const key = normalizeOrderNumber(o.orderNumber);
    if (!key) continue;
    const expected = expectedReceiptCats(o, (posByKey && posByKey[key]) || []);
    const present = presentReceiptCats(byKey[key] || []);
    const missing = expected.filter((c) => !present.has(c));
    if (!missing.length) continue;
    const client = (String(o.companyName == null ? '' : o.companyName).trim())
      || (String(o.clientName == null ? '' : o.clientName).trim()) || '—';
    rows.push({
      orderNumber: key,
      projectNumber: o.projectNumber || '',
      client,
      paid: !!o.paid,
      status: o.status || '',
      missing,                                          // ledger categories, e.g. ['Blank COGS','Shipping']
      missingLabels: missing.map((c) => RECEIPT_LABEL[c] || c),  // friendly: ['blanks','shipping']
      expected,
    });
  }
  rows.sort((a, b) => Number(b.orderNumber) - Number(a.orderNumber));
  return { orders: rows, count: rows.length };
}

// GET /api/finances/order-actuals?orderNumbers=21,022,#23  — the receipt-derived
// ACTUAL cost for a set of orders, keyed by canonical order number. This is the
// "source of truth = the receipts I upload" figure, surfaced wherever an order or
// project shows its cost (the OrderTracker drawer asks for the open project's
// numbers). Reuses the same COGS_CATEGORIES + signed() rules as the ledger, so the
// actual here equals the by-order `cost` to the cent. With no orderNumbers given,
// returns an empty map (callers always know which orders they're asking about).
const orderActuals = async (req, res) => {
  try {
    const raw = String((req.query && req.query.orderNumbers) || '');
    const keys = [...new Set(raw.split(',').map(normalizeOrderNumber).filter(Boolean))];
    if (!keys.length) return res.json({ actuals: {} });
    // Pull only this set's rows. We over-match on the stored leading-zero variants
    // by anchoring ^0*<digits>$ per key, then group canonically.
    const orRegex = keys.map((k) => new RegExp(`^0*${k}$`));
    const rows = await Transaction.find({ type: 'expense', orderNumber: { $in: orRegex } })
      .select('type category amount isCredit orderNumber receiptUrl').lean();
    res.json({ actuals: actualCostByOrder(rows) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// CANONICAL order-number → CRM companyKey map, for cross-linking a finance row
// (which only carries a free-text client name) to the RIGHT CRM company card.
// Keys via normalizeOrderNumber on BOTH sides so a "0000021" order and a "21"
// ledger row resolve identically — the SAME bridge byOrder/byClient already use.
//
// The authoritative key is the Order's stored `companyKey` (derived from
// company/client name), NOT a re-slug of the ledger `party` name — so the link
// can't drift to a near-miss company. Safety on ambiguity: if two Orders that
// share a canonical number map to DIFFERENT companyKeys, we DON'T guess — that
// number's entry is left '' so the frontend disables the link rather than
// mis-linking two companies that happen to share a number. A blank/absent
// companyKey on an order never overwrites a real one already seen for that key.
// Pure (POJOs in, plain object out) so it's unit-testable without Mongo.
function companyKeyByOrderNumber(orders) {
  const map = {};
  (Array.isArray(orders) ? orders : []).forEach((o) => {
    if (!o) return;
    const key = normalizeOrderNumber(o.orderNumber);
    if (!key) return;
    const ck = String(o.companyKey || '').trim();
    if (!ck) return;                                  // nothing to link on
    if (!(key in map)) { map[key] = ck; return; }     // first real key wins
    if (map[key] && map[key] !== ck) map[key] = null; // genuine collision → ambiguous, don't guess
  });
  // Normalize the ambiguous sentinel to '' for a clean, JSON-friendly shape.
  Object.keys(map).forEach((k) => { if (!map[k]) map[k] = ''; });
  return map;
}

// GET /api/finances/by-order?year=  — per-order P&L: revenue, cost, profit,
// margin %. An order's economics span time — the sale lands one day, the blanks
// and the printer invoice another, a reprint or trailing freight weeks later,
// sometimes across a year boundary. So we group an order across ALL its dates,
// net full revenue vs. full cost, and anchor it to the year it was SOLD (its
// first Customer Sales date). That stops a late-December order whose costs hit
// in January from showing up as a phantom loss in the new year.
//
// Each row also carries an authoritative `companyKey` (Order join on the
// canonical number) so the UI can deep-link the client name straight to its CRM
// card — '' when no order resolves (or the number is shared/ambiguous), which
// the UI treats as "not linked" (no dead-end).
const byOrder = async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const rows = await Transaction.find({ orderNumber: { $ne: '' } }).lean();
    // CRM bridge: this order#→companyKey map is built from the Orders' stored
    // canonical companyKey, so the client-name link resolves to the exact card.
    const orderDocs = await Order.find({ orderNumber: { $ne: '' } })
      .select('orderNumber companyKey').lean();
    const ckByOrder = companyKeyByOrderNumber(orderDocs);
    // The set of REAL order numbers (canonical). A transaction whose orderNumber
    // matches none of these is an ORPHAN — almost always a mis-keyed receipt (e.g.
    // a blanks receipt booked under a typo'd #). We drop those phantom rows from
    // the per-order P&L so a bad number can't masquerade as its own order. The cost
    // still counts in the headline totals, and the row stays in Transactions where
    // it can be re-pointed to the right order.
    const realOrderKeys = new Set(orderDocs.map((o) => normalizeOrderNumber(o.orderNumber)).filter(Boolean));
    const cogs = new Set(Transaction.COGS_CATEGORIES);
    const map = {};
    rows.forEach((t) => {
      // Group on the CANONICAL number (leading zeros stripped) so a "0000021" row
      // and a "21" row are the same order — not two split buckets on the drill-in.
      const key = normalizeOrderNumber(t.orderNumber);
      if (!key) return;
      const o = (map[key] ||= { orderNumber: key, client: '', revenue: 0, cost: 0, saleDate: null, firstDate: null });
      const d = t.date && !isNaN(new Date(t.date).getTime()) ? new Date(t.date) : null;
      if (d && (!o.firstDate || d < o.firstDate)) o.firstDate = d;
      if (t.type === 'income') {
        // Customer Sales counts as-is (a credit nets down); a 'Refund' row is
        // contra-revenue (−|amount|) — identical to the headline P&L, so the
        // refunded order and the top-line finally reconcile. Other income → 0.
        o.revenue += orderRevenueContribution(t);
        if (t.category === 'Customer Sales') {
          if (!o.client) o.client = t.party;
          if (d && (!o.saleDate || d < o.saleDate)) o.saleDate = d;      // anchor = when it sold
        }
      } else if (t.type === 'expense' && cogs.has(t.category)) {
        o.cost += signed(t);      // a COGS credit = supplier credit → nets cost down
      }
    });
    let orders = Object.values(map).map((o) => {
      const anchor = o.saleDate || o.firstDate;
      const profit = round2(o.revenue - o.cost);
      return {
        orderNumber: o.orderNumber, client: o.client,
        companyKey: ckByOrder[o.orderNumber] || '',   // '' = not linkable (no/ambiguous order)
        year: anchor ? new Date(anchor).getUTCFullYear() : null,
        revenue: round2(o.revenue), cost: round2(o.cost), profit,
        margin: pct(profit, o.revenue),
      };
    });
    orders = orders.filter((o) => realOrderKeys.has(o.orderNumber) && (o.revenue !== 0 || o.cost !== 0));  // real orders only — drop $0/$0 ghosts AND orphans whose order# matches no order (mis-keyed receipts)
    if (year) orders = orders.filter((o) => o.year === year);  // by the year it SOLD, not by cost dates
    orders.sort((a, b) => Number(b.orderNumber) - Number(a.orderNumber));
    res.json({ orders });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/finances/payment-gaps?year=  — the "money owed to you / unrecorded
// payments" lens: per order, billed vs collected vs cost, flagging orders with
// COST recorded but NO client payment, and billed-but-not-collected. This is the
// additive view that EXPLAINS why net profit reads low — vendor costs were entered
// without the matching customer income. The P&L itself stays cash-honest; this
// just surfaces the gap so the owner can close it (record the missing payment).
//
// Year scoping mirrors byOrder's sale-anchor, with one addition: an order that has
// cost but NO sale has no Customer-Sales date to anchor on, so it would vanish from
// every year. For those we anchor to the EARLIEST cost (COGS) date instead, so a
// "cost in 2026, no payment yet" order correctly shows under 2026 — exactly the
// order the owner needs to see. Reuses paymentGapsForOrders for all the math.
const paymentGaps = async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const orders = await Order.find({ orderNumber: { $ne: '' } })
      .select('orderNumber companyName clientName totalValue paid').lean();
    const txns = await Transaction.find({ orderNumber: { $ne: '' } })
      .select('type category amount isCredit orderNumber date').lean();

    if (!year) return res.json(paymentGapsForOrders(orders, txns));

    // Per canonical order key: the sale-anchor year (first Customer-Sales date),
    // and the earliest cost year as a fallback for orders with cost but no sale.
    const cogs = new Set(Transaction.COGS_CATEGORIES);
    const saleYear = {}, costYear = {};
    for (const t of txns) {
      const k = normalizeOrderNumber(t.orderNumber);
      if (!k || !t.date) continue;
      const y = new Date(t.date).getUTCFullYear();
      if (t.type === 'income' && t.category === 'Customer Sales') {
        if (saleYear[k] == null || y < saleYear[k]) saleYear[k] = y;
      } else if (t.type === 'expense' && cogs.has(t.category)) {
        if (costYear[k] == null || y < costYear[k]) costYear[k] = y;
      }
    }
    const inYear = (key) => {
      const anchor = saleYear[key] != null ? saleYear[key] : costYear[key];
      return anchor === year;
    };
    const scopedOrders = orders.filter((o) => inYear(normalizeOrderNumber(o.orderNumber)));
    // Keep all txns (the pure fn only pulls the ones matching scopedOrders' keys),
    // so a cross-year cost still nets correctly into its order's figures.
    res.json(paymentGapsForOrders(scopedOrders, txns));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/finances/missing-receipts — active in-progress orders (paid OR in
// production, not yet delivered/cancelled) that are missing an expected COGS
// receipt, naming the specific missing type(s) per order. The owner's "did I
// forget to enter a receipt?" surface, finance-side. Not year-scoped — an
// in-progress order is current by definition.
const missingReceipts = async (req, res) => {
  try {
    const orders = await Order.find({
      status: { $nin: ['delivered', 'cancelled'] },
      $or: [{ paid: true }, { status: { $in: IN_PROGRESS_STATUSES } }],
      orderNumber: { $ne: '' },
    }).select('orderNumber projectNumber companyName clientName paid status shippingCost').lean();
    if (!orders.length) return res.json({ orders: [], count: 0 });

    const keys = [...new Set(orders.map((o) => normalizeOrderNumber(o.orderNumber)).filter(Boolean))];
    if (!keys.length) return res.json({ orders: [], count: 0 });
    // Match the stored leading-zero variants (^0*<digits>$) like order-actuals does.
    const orRegex = keys.map((k) => new RegExp(`^0*${k}$`));

    // POs link by orderId (ObjectId), so map _id → canonical orderNumber to group
    // them onto the same key the ledger rows use.
    const idToKey = {};
    for (const o of orders) idToKey[String(o._id)] = normalizeOrderNumber(o.orderNumber);
    const [txns, pos] = await Promise.all([
      Transaction.find({ type: 'expense', orderNumber: { $in: orRegex } })
        .select('type category orderNumber').lean(),
      PurchaseOrder.find({ orderId: { $in: orders.map((o) => o._id) }, archived: { $ne: true } })
        .select('orderId blanksProvided').lean(),
    ]);
    const posByKey = {};
    for (const p of pos) {
      const k = idToKey[String(p.orderId)];
      if (!k) continue;
      (posByKey[k] ||= []).push(p);
    }
    res.json(missingReceiptsForOrders(orders, txns, posByKey));
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
      if (!r || !r._id) return;
      // A row with no/invalid date yields null $year/$month → skip it from the
      // trend rather than emit a "null-NaN" phantom bar. (It still counts in the
      // year totals via summary; the trend just needs a real month to place it.)
      if (r._id.y == null || r._id.m == null) return;
      const key = `${r._id.y}-${String(r._id.m).padStart(2, '0')}`;
      const cat = (r._id.category == null || r._id.category === '') ? 'Other' : String(r._id.category);
      const o = (map[key] ||= { month: key, income: 0, expense: 0 });
      const amt = round2(r.total);
      if (r._id.type === 'income') {
        // Mirror the P&L via the same contra-revenue rule: a 'Refund' nets DOWN
        // the month's income (money back to a customer); Owner Contribution is
        // equity → 0; everything else counts as-is.
        o.income += incomeContribution(cat, amt);
      } else if (cat !== 'Owner Draw') o.expense += amt;
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
    // CRM bridge: same authoritative order#→companyKey map byOrder uses, so each
    // client row can deep-link the name straight to its CRM card ('' = not linkable).
    const orderDocs = await Order.find({ orderNumber: { $ne: '' } })
      .select('orderNumber companyKey').lean();
    const ckByOrder = companyKeyByOrderNumber(orderDocs);
    const cogs = new Set(Transaction.COGS_CATEGORIES);
    const orders = {};
    rows.forEach((t) => {
      // Same canonical grouping as byOrder so leading-zero variants of one order
      // number roll into a single order before we attribute it to a client.
      const key = normalizeOrderNumber(t.orderNumber);
      if (!key) return;
      const o = (orders[key] ||= { client: '', companyKey: ckByOrder[key] || '', revenue: 0, cost: 0, saleDate: null, firstDate: null });
      const d = t.date && !isNaN(new Date(t.date).getTime()) ? new Date(t.date) : null;
      if (d && (!o.firstDate || d < o.firstDate)) o.firstDate = d;
      if (t.type === 'income') {
        o.revenue += orderRevenueContribution(t);   // Customer Sales + Refund contra (headline-consistent)
        if (t.category === 'Customer Sales') {
          if (!o.client) o.client = t.party;
          if (d && (!o.saleDate || d < o.saleDate)) o.saleDate = d;
        }
      } else if (t.type === 'expense' && cogs.has(t.category)) o.cost += signed(t);
    });
    const byC = {};
    Object.values(orders).forEach((o) => {
      const anchor = o.saleDate || o.firstDate;
      const oy = anchor ? new Date(anchor).getUTCFullYear() : null;
      if (year && oy !== year) return;
      if (o.revenue === 0 && o.cost === 0) return;             // skip $0/$0 ghosts (order# on a non-COGS line)
      const name = (String(o.client == null ? '' : o.client).trim()) || '—';
      const c = (byC[name] ||= { client: name, companyKey: '', revenue: 0, cost: 0, orders: 0 });
      if (!c.companyKey && o.companyKey) c.companyKey = o.companyKey;   // first real key wins (deep-link target)
      c.revenue += o.revenue; c.cost += o.cost; c.orders += 1;
    });
    const clients = Object.values(byC).map((c) => {
      const profit = round2(c.revenue - c.cost);
      return { client: c.client, companyKey: c.companyKey || '', orders: c.orders, revenue: round2(c.revenue), cost: round2(c.cost), profit, margin: pct(profit, c.revenue) };
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
    txns.forEach((t) => {
      if (!t) return;                                   // skip a null row rather than throw
      // A missing/invalid date must NOT crash the whole export — .toISOString()
      // throws on an Invalid Date. Emit a blank date cell for that one row and keep
      // going (the export stays downloadable no matter how dirty the data is).
      const d = t.date ? new Date(t.date) : null;
      const dateCell = d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
      lines.push([
        dateCell,
        t.type === 'income' ? 'Income' : 'Expense',
        t.category, t.orderNumber, t.party, t.description,
        // Credits export as a negative amount so a re-import re-flags them.
        round2(signed(t)), t.qbSynced ? 'Yes' : 'No',
      ].map(csvCell).join(','));
    });
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

module.exports = { importCsv, list, create, update, remove, summary, byOrder, byMonth, byClient, exportCsv, orderActuals, paymentGaps, missingReceipts, resyncYears };
// Reusable, DB-free finance math for other surfaces (CRM company page, the order
// view) + tests. All keyed off the SAME Transaction truth via these helpers.
module.exports.summarizeCompanyFinance = summarizeCompanyFinance;
module.exports.normalizeOrderNumber = normalizeOrderNumber;
module.exports.companyKeyByOrderNumber = companyKeyByOrderNumber;
module.exports.orderRevenueCost = orderRevenueCost;
module.exports.orderActualCost = orderActualCost;
module.exports.actualCostByOrder = actualCostByOrder;
module.exports.paymentGapsForOrders = paymentGapsForOrders;
module.exports.missingReceiptsForOrders = missingReceiptsForOrders;
module.exports.expectedReceiptCats = expectedReceiptCats;
module.exports.orderInProgress = orderInProgress;
module.exports.pct = pct;
module.exports.signed = signed;
module.exports.incomeContribution = incomeContribution;
module.exports.orderRevenueContribution = orderRevenueContribution;
module.exports.processingFeeRate = processingFeeRate;
module.exports.computeProcessingFee = computeProcessingFee;
module.exports.buildProcessingFeeDoc = buildProcessingFeeDoc;
module.exports.inferRowType = inferRowType;
