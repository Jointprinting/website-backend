#!/usr/bin/env node
/* eslint-disable no-console */
//
// scripts/buildFinanceSeed.js
//
// REPRODUCIBLE seed builder for the owner's REAL cash ledger. Reads his three
// monthly budget trackers (budget_2024/2025/2026.xlsx — his financial source of
// truth) and emits a clean, categorized, deduped finance seed at
//   data/financeLedgerSeed.json
// which the finance RESTART flow (controllers/financeRestart.js) loads to REPLACE
// the uncertain in-app finance data with his verified ledger.
//
// WHY a committed builder (not a one-off): the seed is regenerated from the source
// workbooks on demand, so the transformation (sheet layout → rows → categories →
// party dedup → normalized order numbers) is auditable and re-runnable, exactly
// like scripts/buildNotionCrmSeed.js does for the CRM.
//
// THE BUDGET CONVENTION (verified against the owner's pre-parse: 330 rows, net
// cash = $22,413.41):
//   • Each month is a sheet with a DEBIT side (money IN — income/sales) and a
//     CREDIT side (money OUT — expenses/COGS). Each side has Date / Sum /
//     Description (+ "Recorded in QB?" on the 2025/2026 layout).
//   • The SIDE decides income vs expense — NOT the text. A "Sales - Heritage …"
//     line on the CREDIT side is a COST paid to the printer Heritage, not revenue.
//   • Description holds the party + "(Order #N)". Order numbers are the owner's
//     OWN manual sequence and are UNRELIABLE for identity (he mis-numbered some);
//     we keep the normalized number as a HINT only — order grouping/identity is
//     resolved later (client + amount + date) by the restart layer, never keyed
//     off this number.
//   • Rows below a "Total" summary row are still real (the owner appends late
//     entries under the month's totals) — we read EVERY row with a numeric Sum and
//     a non-"Total" Description, skipping only the summary/blank rows.
//
// Requires python3 + openpyxl (xlsx parsing). The JS here shells out to a small
// embedded python parser (the workbooks are .xlsx; openpyxl is the available,
// reliable reader), then does all the categorization / dedup / shaping in JS so it
// stays consistent with the rest of the codebase and is unit-testable via the pure
// helpers in services/financeSeed.js.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  categorize, canonicalParty, normalizeOrderNumber, parseOrderHint,
} = require('../services/financeSeed');

const ROOT = path.join(__dirname, '..');
// The workbooks are staged OUTSIDE the repo (financial data is NEVER committed).
// Point FINANCE_BUDGET_DIR at the directory holding budget_2024/2025/2026.xlsx.
// Falls back to a local ./budgets dir for a manual run; the staged path is passed
// via the env var so no absolute machine path is committed.
const BUDGET_DIR = process.env.FINANCE_BUDGET_DIR || path.join(ROOT, 'budgets');
const OUT_PATH = path.join(ROOT, 'data', 'financeLedgerSeed.json');

const WORKBOOKS = [
  { year: 2024, file: 'budget_2024.xlsx' },
  { year: 2025, file: 'budget_2025.xlsx' },
  { year: 2026, file: 'budget_2026.xlsx' },
];

// Embedded python: parse one workbook → JSON array of raw rows
//   { year, month, side('income'|'expense'), date(ISO|''), sum, desc, qb }
// The layout differs by year (2024: Debit@E/Credit@I; 2025-26: Debit@C/Credit@H),
// so we LOCATE the Debit/Credit headers and the Date/Sum/Description sub-headers
// rather than hardcode columns. No early termination on "Total" — see header note.
const PY_PARSER = `
import sys, json, openpyxl
def find_layout(ws):
    debit_c=credit_c=hdr_row=None
    for r in range(1,8):
        for c in range(1,28):
            v=ws.cell(row=r,column=c).value
            if v is None: continue
            s=str(v).strip().lower()
            if s=='debit': debit_c=c; hdr_row=r
            if s=='credit': credit_c=c
    if hdr_row is None or credit_c is None: return None
    sub_row=None
    for r in range(hdr_row,hdr_row+3):
        for c in range(1,28):
            v=ws.cell(row=r,column=c).value
            if v is not None and str(v).strip().lower()=='sum': sub_row=r; break
        if sub_row: break
    if sub_row is None: return None
    labels={}
    for c in range(1,28):
        v=ws.cell(row=sub_row,column=c).value
        if v is not None and str(v).strip(): labels[c]=str(v).strip().lower()
    def side_cols(lo,hi):
        d=s=desc=qb=None
        for c,lab in labels.items():
            if c<lo or c>=hi: continue
            if lab=='date': d=c
            elif lab=='sum': s=c
            elif lab=='description': desc=c
            elif 'recorded' in lab or lab=='qb': qb=c
        return [d,s,desc,qb]
    return dict(sub_row=sub_row, debit=side_cols(0,credit_c), credit=side_cols(credit_c,99))
def cell_iso(v):
    try: return v.isoformat()[:10]
    except Exception: return ''
out=[]
wb=openpyxl.load_workbook(sys.argv[1], data_only=True)
year=int(sys.argv[2])
for sn in wb.sheetnames:
    ws=wb[sn]
    lay=find_layout(ws)
    if not lay: continue
    start=lay['sub_row']+1
    for side,cols in (('income',lay['debit']),('expense',lay['credit'])):
        dcol,scol,desccol,qbcol=cols
        if scol is None or desccol is None: continue
        for r in range(start, ws.max_row+1):
            desc=ws.cell(row=r,column=desccol).value
            ds='' if desc is None else str(desc).strip()
            if not ds or ds.lower()=='total': continue
            summ=ws.cell(row=r,column=scol).value
            try: amt=float(summ)
            except (TypeError,ValueError): continue
            if amt==0: continue
            dt=ws.cell(row=r,column=dcol).value if dcol else None
            qb=ws.cell(row=r,column=qbcol).value if qbcol else None
            out.append(dict(year=year, month=sn, side=side, date=cell_iso(dt),
                            sum=round(amt,2), desc=ds, qb=('' if qb is None else str(qb).strip())))
print(json.dumps(out))
`;

function parseWorkbook(file, year) {
  const full = path.join(BUDGET_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Budget workbook not found: ${full}. Set FINANCE_BUDGET_DIR or stage the file.`);
  }
  const raw = execFileSync('python3', ['-c', PY_PARSER, full, String(year)], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

// A "Recorded in QB?" cell of Yes (the 2025/2026 layout) → recordedInQB true.
function qbTrue(qb) {
  return /^y(es)?$/i.test(String(qb || '').trim());
}

// Sheet name → 0-based month index (the workbooks' sheets are full month names).
const MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Resolve a row's date. MANY budget rows are undated — the owner appends late
// entries (e.g. the rows below a month's "Total") with no date cell. Those MUST
// still get a real calendar date, because (a) Transaction.date is required and
// (b) the whole finance UI filters by YEAR via the date — an undated row would be
// invisible in every year's P&L/trend. We anchor an undated row to the FIRST of
// its sheet's month (the owner filed it under that month), keeping it in the right
// year+month bucket. Dated rows keep their exact date. Returns an ISO yyyy-mm-dd.
function resolveDate(r) {
  if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) return r.date;
  const mi = MONTH_INDEX[String(r.month || '').trim().toLowerCase()];
  if (mi == null) return `${r.year}-01-01`;     // unknown sheet → year start (last resort)
  return `${r.year}-${String(mi + 1).padStart(2, '0')}-01`;
}

function buildSeed() {
  const rawRows = [];
  for (const wb of WORKBOOKS) rawRows.push(...parseWorkbook(wb.file, wb.year));

  const rows = rawRows.map((r) => {
    const isIncome = r.side === 'income';
    const { category, party } = categorize(r.desc, isIncome);
    const orderNumber = parseOrderHint(r.desc); // normalized digits, '' if none
    const date = resolveDate(r);                // exact date, or 1st-of-sheet-month for undated
    return {
      date,                                      // ISO yyyy-mm-dd (always set — never blank)
      dateExact: !!(r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)), // false ⇒ month-anchored fallback
      type: isIncome ? 'income' : 'expense',
      amount: Number(r.sum),                     // positive magnitude
      category,
      party: canonicalParty(party),              // dedup spelling variants
      orderNumber,                               // HINT only (owner's manual #, normalized)
      description: r.desc,
      recordedInQB: qbTrue(r.qb),
      year: Number(date.slice(0, 4)),
      source: 'budget',
    };
  });

  // Stable sort by date then description so the committed seed is deterministic
  // (a re-run produces a byte-identical file, friendly to git review).
  rows.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.description.localeCompare(b.description));

  return rows;
}

function summarize(rows) {
  const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  // Two distinct figures, both correct and both reported:
  //   • rawCashNet = Σ(all debit/income rows) − Σ(all credit/expense rows) = the
  //     owner's literal bank-balance change. This is the INTEGRITY cross-check that
  //     must reconcile to the owner pre-parse ($22,413.41) — it proves we read every
  //     row's amount + side correctly, before any P&L refinement.
  //   • net (P&L profit) = revenue (Customer Sales, refunds netted contra, Owner
  //     Contribution EXCLUDED) − operating expense (Owner Draw EXCLUDED) — the
  //     finance-page "profit". A SMALLER number than cash net by design (the $8,000
  //     owner deposit is equity in, the draw is a distribution, not earnings/cost).
  let rawDebit = 0, rawCredit = 0;
  let income = 0, expense = 0, ownerContribution = 0, ownerDraw = 0, refund = 0;
  const byCategory = {};
  const clients = new Set();
  const vendors = new Set();
  const orderNums = new Set();
  for (const t of rows) {
    byCategory[t.category] = r2((byCategory[t.category] || 0) + t.amount);
    if (t.orderNumber) orderNums.add(t.orderNumber);
    if (t.type === 'income') {
      rawDebit += t.amount;
      if (t.category === 'Owner Contribution') ownerContribution += t.amount;
      else if (t.category === 'Refund') { refund += t.amount; income -= t.amount; }
      else { income += t.amount; if (t.party) clients.add(t.party); }
    } else {
      rawCredit += t.amount;
      if (t.category === 'Owner Draw') ownerDraw += t.amount;
      else { expense += t.amount; if (t.party) vendors.add(t.party); }
    }
  }
  return {
    rows: rows.length,
    rawCashNet: r2(rawDebit - rawCredit),                 // integrity check → $22,413.41
    income: r2(income), expense: r2(expense), net: r2(income - expense), // P&L profit
    ownerContribution: r2(ownerContribution), ownerDraw: r2(ownerDraw), refund: r2(refund),
    byCategory,
    distinctOrderNumbers: orderNums.size,
    distinctClients: clients.size,
    distinctVendors: vendors.size,
    clients: [...clients].sort(),
    vendors: [...vendors].sort(),
  };
}

function main() {
  const rows = buildSeed();
  const summary = summarize(rows);
  const payload = {
    generatedAt: new Date().toISOString(),
    note: 'Built by scripts/buildFinanceSeed.js from the owner budget trackers. Net cash must reconcile to $22,413.41.',
    summary,
    rows,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');

  // VERIFY printout (the cross-check the owner asked for).
  console.log('Wrote', OUT_PATH);
  console.log('Rows:                  ', summary.rows);
  console.log('— Integrity (cash) —');
  console.log('  Raw cash net:        $' + summary.rawCashNet.toLocaleString(), '  (target $22,413.41 — every debit − every credit)');
  console.log('— P&L (finance page) —');
  console.log('  Revenue (income):    $' + summary.income.toLocaleString(), '  (Customer Sales, refunds netted contra; Owner Contribution excluded)');
  console.log('  Operating expense:   $' + summary.expense.toLocaleString(), '  (Owner Draw excluded)');
  console.log('  NET PROFIT:          $' + summary.net.toLocaleString());
  console.log('  Owner Contribution:  $' + summary.ownerContribution.toLocaleString(), '  (equity in — NOT revenue/profit)');
  console.log('  Owner Draw:          $' + summary.ownerDraw.toLocaleString(), '  (equity out — NOT expense/profit)');
  console.log('  Refund (contra):     $' + summary.refund.toLocaleString());
  console.log('  Distinct order #s:   ', summary.distinctOrderNumbers, '(budget hints — unreliable, not order identity)');
  console.log('  Distinct clients:    ', summary.distinctClients);
  console.log('  Distinct vendors:    ', summary.distinctVendors);
  console.log('\nPer-category totals:');
  Object.entries(summary.byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('  ' + k.padEnd(20) + ' $' + v.toLocaleString()));

  // The INTEGRITY check is on raw cash net (proves the parse is complete + correct),
  // NOT on P&L profit (which is intentionally smaller after equity/refund refinement).
  const CASH_TARGET = 22413.41;
  if (Math.abs(summary.rawCashNet - CASH_TARGET) > 0.01) {
    console.error(`\n*** RAW CASH NET MISMATCH: got ${summary.rawCashNet}, expected ${CASH_TARGET} ***`);
    process.exitCode = 1;
  } else {
    console.log('\nRaw cash net reconciles to the owner pre-parse ($22,413.41) ✓');
  }
}

if (require.main === module) main();

module.exports = { buildSeed, summarize };
