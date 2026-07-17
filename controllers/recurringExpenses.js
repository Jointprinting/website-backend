// controllers/recurringExpenses.js
//
// The owner's recurring OPERATING subscriptions (Google Workspace, Render,
// ChatGPT, Claude, Planet Fitness, the backup domain, …) — the cost-side twin of
// controllers/subscriptions.js. Two jobs:
//   1. Track what recurs + when it bills, and REMIND (Finances-page-only) when a
//      month's invoice is past due and hasn't been uploaded/recorded yet.
//   2. When the invoice lands, book ONE clean brand-tagged expense into the ledger
//      (optionally attaching the stored file) and mark that period settled.
//
// The date math is pure + exported so the reminder logic is unit-tested with no DB
// or clock. Everything is UTC-day granularity — these are reminders, not receipts.

const RecurringExpense = require('../models/RecurringExpense');
const Transaction = require('../models/Transaction');
const { isBrand } = require('../utils/brands');
const r2 = require('../services/r2');

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');

// ── Pure period math (exported for tests) ────────────────────────────────────

// The period key a date falls in: 'YYYY-MM' monthly, 'YYYY' annual.
function periodKey(date, cadence) {
  const d = new Date(date);
  return cadence === 'annual'
    ? String(d.getUTCFullYear())
    : `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// The actual due DATE for a given year/month and a nominal due day, clamped to the
// month's length (a due day of 31 bills on Feb 28/29, Apr 30, …).
function dueDateFor(year, monthIdx, dueDay) {
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const day = Math.min(Math.max(1, num(dueDay) || 1), daysInMonth);
  return new Date(Date.UTC(year, monthIdx, day));
}

// Every due date from the subscription's start through `today` (inclusive), oldest
// first. Monthly walks month by month; annual year by year. Only the most recent 24
// are kept so a mis-set far-past start can't spawn an unbounded reminder list.
function expectedDueDates(exp, today) {
  const start = exp && exp.startDate ? new Date(exp.startDate) : new Date(today);
  const now = new Date(today);
  const out = [];
  const CAP = 24;
  const MAX_ITER = 1300; // safety valve (>100 years of months)

  if (exp && exp.cadence === 'annual') {
    let y = start.getUTCFullYear();
    for (let i = 0; i < MAX_ITER; i++) {
      const due = dueDateFor(y, start.getUTCMonth(), start.getUTCDate());
      if (due > now) break;
      if (due >= start) out.push(due);
      y += 1;
    }
    return out.slice(-CAP);
  }

  // The first billed date is the first due-day on/after the start (if the start day
  // is past this month's due day, billing begins next month).
  let fy = start.getUTCFullYear();
  let fm = start.getUTCMonth();
  let firstDue = dueDateFor(fy, fm, exp && exp.dueDay);
  if (firstDue < new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))) {
    fm += 1; if (fm > 11) { fm = 0; fy += 1; }
    firstDue = dueDateFor(fy, fm, exp && exp.dueDay);
  }
  let y = fy;
  let m = fm;
  for (let i = 0; i < MAX_ITER; i++) {
    const due = dueDateFor(y, m, exp && exp.dueDay);
    if (due > now) break;
    out.push(due);
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return out.slice(-CAP);
}

// The next upcoming due date strictly after `today` (for "bills again on …").
function nextDueDate(exp, today) {
  const now = new Date(today);
  if (exp && exp.cadence === 'annual') {
    let y = now.getUTCFullYear();
    for (let i = 0; i < 3; i++) {
      const due = dueDateFor(y + i, (exp.startDate ? new Date(exp.startDate) : now).getUTCMonth(),
        (exp.startDate ? new Date(exp.startDate) : now).getUTCDate());
      if (due > now) return due;
    }
    return null;
  }
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  for (let i = 0; i < 13; i++) {
    const due = dueDateFor(y, m, exp && exp.dueDay);
    if (due > now) return due;
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return null;
}

// The reminder/status view of ONE subscription as of `today`. Pure.
//   state: 'inactive'  — archived/paused (active:false)
//          'not_started' — startDate is in the future
//          'awaiting'  — an elapsed due date has no recorded/skipped period (NAG)
//          'upcoming'  — all elapsed periods settled; next charge is in the future
function expenseStatus(exp, today) {
  const now = new Date(today);
  const settled = new Set((exp.periods || []).map((p) => p.period)); // recorded OR skipped
  // A period that was explicitly SKIPPED is settled (off the nag list) but NOT recorded
  // — it booked no cost. Track the two separately so a skipped current period doesn't
  // render as "Recorded ✓" with a bogus Undo (the income side already splits these).
  const recorded = new Set((exp.periods || []).filter((p) => p.status === 'recorded').map((p) => p.period));
  const next = nextDueDate(exp, now);
  if (!exp.active || exp.archived) {
    return { state: 'inactive', awaiting: [], nextDue: next, currentPeriod: periodKey(now, exp.cadence) };
  }
  const start = exp.startDate ? new Date(exp.startDate) : now;
  if (start > now) {
    return { state: 'not_started', awaiting: [], nextDue: start, currentPeriod: periodKey(start, exp.cadence) };
  }
  const dues = expectedDueDates(exp, now);
  const awaiting = dues
    .map((due) => ({ period: periodKey(due, exp.cadence), due, daysOverdue: Math.floor((now - due) / 86400000) }))
    .filter((d) => !settled.has(d.period));
  const currentPeriod = dues.length ? periodKey(dues[dues.length - 1], exp.cadence) : periodKey(now, exp.cadence);
  return {
    state: awaiting.length ? 'awaiting' : 'upcoming',
    awaiting,               // oldest-first; the current month is the last element
    nextDue: next,
    currentPeriod,
    recordedThisPeriod: recorded.has(currentPeriod),
    skippedThisPeriod: settled.has(currentPeriod) && !recorded.has(currentPeriod),
  };
}

// Roll the whole list up for the Finances page: decorate each with its status +
// build the flat reminder list (only active, reminders-on, awaiting subs). Pure.
function summarize(expenses, today) {
  const now = new Date(today);
  const rows = (expenses || []).map((e) => {
    const exp = typeof e.toObject === 'function' ? e.toObject() : e;
    return { ...exp, status: expenseStatus(exp, now) };
  });
  const reminders = [];
  for (const r of rows) {
    if (!r.active || r.archived || r.remindersOn === false) continue;
    for (const a of r.status.awaiting) {
      reminders.push({
        id: r._id, name: r.name, amount: r.amount, dueDay: r.dueDay,
        period: a.period, due: a.due, daysOverdue: a.daysOverdue,
      });
    }
  }
  reminders.sort((a, b) => b.daysOverdue - a.daysOverdue); // most overdue first
  const activeRows = rows.filter((r) => r.active && !r.archived);
  const monthlyTotal = round2(activeRows.reduce(
    (s, r) => s + (r.cadence === 'annual' ? num(r.amount) / 12 : num(r.amount)), 0));
  return {
    expenses: rows,
    reminders,
    summary: {
      monthlyTotal,
      annualTotal: round2(monthlyTotal * 12),
      count: activeRows.length,
      awaitingCount: reminders.length,
    },
  };
}

// ── HTTP handlers (admin-only via the route) ─────────────────────────────────

// GET /api/recurring-expenses — the full list + decorated status + reminders.
async function list(req, res) {
  try {
    const expenses = await RecurringExpense.find({ archived: { $ne: true } })
      .sort({ order: 1, name: 1 }).lean();
    res.json(summarize(expenses, new Date()));
  } catch (e) { res.status(500).json({ message: e.message }); }
}

const EDITABLE = ['name', 'vendor', 'amount', 'cadence', 'dueDay', 'category', 'brand', 'startDate', 'active', 'remindersOn', 'notes', 'order'];

function coerce(body, into = {}) {
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    if (k === 'amount') into.amount = Math.max(0, num(body.amount));
    else if (k === 'dueDay') into.dueDay = Math.min(31, Math.max(1, Math.round(num(body.dueDay)) || 1));
    else if (k === 'cadence') { if (RecurringExpense.RECUR_CADENCES.includes(body.cadence)) into.cadence = body.cadence; }
    else if (k === 'brand') { if (isBrand(body.brand)) into.brand = body.brand; }
    else if (k === 'startDate') into.startDate = body.startDate ? new Date(body.startDate) : new Date();
    else if (k === 'active' || k === 'remindersOn') into[k] = !!body[k];
    else into[k] = body[k];
  }
  return into;
}

// POST /api/recurring-expenses
async function create(req, res) {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ message: 'name required' });
    const doc = await RecurringExpense.create(coerce(b, { name: b.name }));
    res.status(201).json(doc);
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// PUT /api/recurring-expenses/:id — edit any config field (amount, due day, …).
async function update(req, res) {
  try {
    const set = coerce(req.body || {});
    const doc = await RecurringExpense.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
    if (!doc) return res.status(404).json({ message: 'not found' });
    res.json(doc);
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// DELETE /api/recurring-expenses/:id — soft-delete (archive), house rule.
async function remove(req, res) {
  try {
    const doc = await RecurringExpense.findByIdAndUpdate(
      req.params.id,
      { $set: { archived: true, archivedAt: new Date(), archivedReason: 'manual', active: false } },
      { new: true });
    if (!doc) return res.status(404).json({ message: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// POST /api/recurring-expenses/:id/record — the invoice for a period landed. Books
// ONE brand-tagged expense Transaction (idempotent per period — updates the row on a
// re-record instead of stacking), optionally storing the uploaded file, and marks
// the period settled so its reminder clears. Body:
//   { period?, amount?, date?, fileDataUrl?, fileName?, note? }
// period/amount/date default to the subscription's config for the current period.
async function record(req, res) {
  try {
    const exp = await RecurringExpense.findById(req.params.id);
    if (!exp) return res.status(404).json({ message: 'not found' });
    const b = req.body || {};

    const status = expenseStatus(exp.toObject(), new Date());
    // Default to the oldest still-awaiting period, else the current period.
    const period = b.period
      || (status.awaiting[0] && status.awaiting[0].period)
      || status.currentPeriod;
    const amount = round2(b.amount != null ? b.amount : exp.amount);
    if (!(amount > 0)) return res.status(400).json({ message: 'An amount is required to record this invoice.' });
    const date = b.date ? new Date(b.date) : new Date();

    // Store the invoice file (best-effort) so the original lives in the archive.
    let receiptUrl = '';
    if (b.fileDataUrl) {
      const m = String(b.fileDataUrl).match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
      if (m && r2.isR2Configured()) {
        try { receiptUrl = await r2.uploadBuffer(Buffer.from(m[2], 'base64'), m[1].toLowerCase(), 'receipts'); }
        catch (_e) { /* a storage hiccup must never block booking the cost */ }
      }
    }

    const existing = (exp.periods || []).find((p) => p.period === period);
    const txnFields = {
      date, type: 'expense', category: exp.category || 'Software',
      party: exp.vendor || exp.name, amount, brand: exp.brand || 'contact',
      description: `${exp.name} — ${period}`, source: 'recurring',
      receiptUrl: receiptUrl || (existing && existing.receiptUrl) || '',
    };
    let txn;
    if (existing && existing.transactionId) {
      txn = await Transaction.findByIdAndUpdate(existing.transactionId, txnFields, { new: true });
    }
    if (!txn) txn = await Transaction.create(txnFields);

    // Upsert the period record (recorded), keeping one entry per period.
    const entry = {
      period, status: 'recorded', amount, recordedAt: new Date(),
      receiptUrl: txnFields.receiptUrl, transactionId: txn._id, note: b.note || '',
    };
    exp.periods = [...(exp.periods || []).filter((p) => p.period !== period), entry];
    await exp.save();

    res.json({ expense: exp, transaction: txn, period });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// POST /api/recurring-expenses/:id/skip — this period wasn't billed (canceled that
// month, comped, etc.). Marks it settled-as-skipped so the reminder clears without
// booking any cost. Body { period? } (defaults to the oldest awaiting).
async function skip(req, res) {
  try {
    const exp = await RecurringExpense.findById(req.params.id);
    if (!exp) return res.status(404).json({ message: 'not found' });
    const status = expenseStatus(exp.toObject(), new Date());
    const period = (req.body && req.body.period)
      || (status.awaiting[0] && status.awaiting[0].period) || status.currentPeriod;
    // If this period was previously RECORDED, skipping it must archive the booked
    // ledger row too (same as unrecord) — otherwise the cost stays in the P&L as an
    // orphan while the period reads "skipped, no cost".
    const existing = (exp.periods || []).find((p) => p.period === period);
    if (existing && existing.transactionId) {
      await Transaction.findByIdAndUpdate(existing.transactionId, { $set: { archived: true, archivedAt: new Date() } });
    }
    exp.periods = [
      ...(exp.periods || []).filter((p) => p.period !== period),
      { period, status: 'skipped', amount: null, recordedAt: new Date(), note: (req.body && req.body.note) || '' },
    ];
    await exp.save();
    res.json({ expense: exp, period });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// POST /api/recurring-expenses/:id/unrecord — undo a settled period. Removes the
// period entry (so it can nag again if still due) and soft-deletes the booked
// ledger row. Body { period } (required).
async function unrecord(req, res) {
  try {
    const exp = await RecurringExpense.findById(req.params.id);
    if (!exp) return res.status(404).json({ message: 'not found' });
    const period = req.body && req.body.period;
    if (!period) return res.status(400).json({ message: 'period required' });
    const entry = (exp.periods || []).find((p) => p.period === period);
    if (entry && entry.transactionId) {
      await Transaction.findByIdAndUpdate(entry.transactionId, { $set: { archived: true, archivedAt: new Date() } });
    }
    exp.periods = (exp.periods || []).filter((p) => p.period !== period);
    await exp.save();
    res.json({ expense: exp, period });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// One-time idempotent seed of the owner's current stack. Upserts by name with
// $setOnInsert so a re-seed never clobbers his edits (changed amounts / due days).
const DEFAULTS = [
  { name: 'Google Workspace',              vendor: 'Google',           amount: 26.40, dueDay: 1,  category: 'Software', startDate: '2026-07-01', order: 1, notes: 'Business Plus (flexible / month-to-month billing).' },
  { name: 'Render',                        vendor: 'Render',           amount: 7,     dueDay: 1,  category: 'Software', startDate: '2026-07-01', order: 2 },
  { name: 'ChatGPT',                       vendor: 'OpenAI',           amount: 20,    dueDay: 19, category: 'Software', startDate: '2026-07-01', order: 3 },
  { name: 'Claude',                        vendor: 'Anthropic',        amount: 100,   dueDay: 21, category: 'Software', startDate: '2026-07-01', order: 4 },
  { name: 'jointprintingshop.com domain (backup)', vendor: 'Domain registrar', amount: 8, dueDay: 20, category: 'Software', startDate: '2026-07-20', order: 6 },
];

async function seedDefaults() {
  let seeded = 0;
  for (const d of DEFAULTS) {
    const r = await RecurringExpense.updateOne(
      { name: d.name },
      { $setOnInsert: { ...d, startDate: new Date(d.startDate), brand: 'contact', active: true, remindersOn: true } },
      { upsert: true });
    if (r.upsertedCount) seeded += 1;
  }
  return { seeded };
}

module.exports = {
  list, create, update, remove, record, skip, unrecord, seedDefaults,
  // pure, exported for tests
  periodKey, dueDateFor, expectedDueDates, nextDueDate, expenseStatus, summarize,
};
