// controllers/__tests__/subscriptions.test.js
//   node --test controllers/__tests__/subscriptions.test.js
//
// Pure MRR/ARR math for the subscription spine (no DB) + the brand vocabulary.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  monthlyAmount, summarizeMrr, nextBillFrom,
  billingPeriodKey, recordStatusFor, dueThisPeriod,
} = require('../subscriptions');
const { BRAND_KEYS, SUBSCRIPTION_BRAND_KEYS, brandLabel, isBrand } = require('../../utils/brands');

const TODAY = new Date('2026-07-17T12:00:00Z');

test('monthlyAmount: only active plans count; annual normalizes to /12', () => {
  assert.equal(monthlyAmount({ status: 'active', amount: 100, cadence: 'monthly' }), 100);
  assert.equal(monthlyAmount({ status: 'active', amount: 1200, cadence: 'annual' }), 100);
  assert.equal(monthlyAmount({ status: 'paused', amount: 100, cadence: 'monthly' }), 0);
  assert.equal(monthlyAmount({ status: 'canceled', amount: 100, cadence: 'monthly' }), 0);
  assert.equal(monthlyAmount({ status: 'active', amount: 0, cadence: 'monthly' }), 0);
  assert.equal(monthlyAmount({ status: 'active', amount: -50, cadence: 'monthly' }), 0);
  assert.equal(monthlyAmount(null), 0);
});

test('summarizeMrr: totals + per-brand split + status counts', () => {
  const subs = [
    { brand: 'webworks', status: 'active',   amount: 99,   cadence: 'monthly' },  // 99
    { brand: 'webworks', status: 'active',   amount: 1200, cadence: 'annual' },   // 100
    { brand: 'webworks', status: 'paused',   amount: 99,   cadence: 'monthly' },  // 0
    { brand: 'atom',     status: 'active',   amount: 299,  cadence: 'monthly' },  // 299
    { brand: 'atom',     status: 'canceled', amount: 299,  cadence: 'monthly' },  // 0
  ];
  const s = summarizeMrr(subs);
  assert.equal(s.mrr, 498);              // 99 + 100 + 299
  assert.equal(s.arr, 5976);             // 498 * 12
  assert.equal(s.active, 3);
  assert.equal(s.paused, 1);
  assert.equal(s.canceled, 1);
  assert.equal(s.count, 5);
  // brand split, sorted by MRR desc → atom (299) before webworks (199)
  assert.equal(s.byBrand[0].brand, 'atom');
  assert.equal(s.byBrand[0].mrr, 299);
  assert.equal(s.byBrand[0].active, 1);
  assert.equal(s.byBrand[0].canceled, 1);
  const ww = s.byBrand.find((b) => b.brand === 'webworks');
  assert.equal(ww.mrr, 199);             // 99 + 100
  assert.equal(ww.arr, 2388);
  assert.equal(ww.active, 2);
  assert.equal(ww.paused, 1);
  assert.equal(ww.label, 'JP Webworks');
});

test('summarizeMrr: empty → all zeros, no brands', () => {
  const s = summarizeMrr([]);
  assert.equal(s.mrr, 0);
  assert.equal(s.arr, 0);
  assert.equal(s.count, 0);
  assert.deepEqual(s.byBrand, []);
});

test('nextBillFrom: adds one cadence period; invalid date → null', () => {
  assert.equal(nextBillFrom('2026-01-15', 'monthly').toISOString().slice(0, 10), '2026-02-15');
  assert.equal(nextBillFrom('2026-01-15', 'annual').toISOString().slice(0, 10), '2027-01-15');
  assert.equal(nextBillFrom('not-a-date', 'monthly'), null);
});

// ── "record this month's plans" period recording ─────────────────────────────

test('billingPeriodKey: monthly YYYY-MM, annual YYYY', () => {
  assert.equal(billingPeriodKey('2026-07-09', 'monthly'), '2026-07');
  assert.equal(billingPeriodKey('2026-07-09', 'annual'), '2026');
});

test('recordStatusFor: current period, recorded vs skipped vs open', () => {
  const base = { cadence: 'monthly', periods: [] };
  assert.deepEqual(recordStatusFor(base, TODAY), { currentPeriod: '2026-07', recorded: false, settled: false });
  const rec = { cadence: 'monthly', periods: [{ period: '2026-07', status: 'recorded' }] };
  assert.deepEqual(recordStatusFor(rec, TODAY), { currentPeriod: '2026-07', recorded: true, settled: true });
  const skip = { cadence: 'monthly', periods: [{ period: '2026-07', status: 'skipped' }] };
  assert.deepEqual(recordStatusFor(skip, TODAY), { currentPeriod: '2026-07', recorded: false, settled: true });
  // a prior month recorded doesn't settle the current one
  const stale = { cadence: 'monthly', periods: [{ period: '2026-06', status: 'recorded' }] };
  assert.equal(recordStatusFor(stale, TODAY).settled, false);
});

test('dueThisPeriod: active + started + unsettled plans only, light rows', () => {
  const subs = [
    { _id: 'a', status: 'active', brand: 'webworks', companyName: 'Acme', plan: 'Care', amount: 99, cadence: 'monthly', startedAt: '2026-01-01', periods: [] },              // due
    { _id: 'b', status: 'active', brand: 'atom', companyName: 'Beta', amount: 299, cadence: 'monthly', startedAt: '2026-01-01', periods: [{ period: '2026-07', status: 'recorded' }] }, // recorded → not due
    { _id: 'c', status: 'active', brand: 'atom', companyName: 'Gamma', amount: 50, cadence: 'monthly', startedAt: '2026-01-01', periods: [{ period: '2026-07', status: 'skipped' }] },   // skipped → not due
    { _id: 'd', status: 'paused', brand: 'webworks', companyName: 'Delta', amount: 99, cadence: 'monthly', startedAt: '2026-01-01', periods: [] },  // paused → not due
    { _id: 'e', status: 'active', brand: 'webworks', companyName: 'Echo', amount: 99, cadence: 'monthly', startedAt: '2026-09-01', periods: [] },   // not started → not due
    { _id: 'f', status: 'active', brand: 'atom', companyName: 'Foxtrot', amount: 1200, cadence: 'annual', startedAt: '2026-01-05', periods: [{ period: '2026', status: 'recorded' }] }, // annual recorded this year → not due
  ];
  const due = dueThisPeriod(subs, TODAY);
  assert.deepEqual(due.map((d) => d.id), ['a']);
  assert.equal(due[0].period, '2026-07');
  assert.equal(due[0].companyName, 'Acme');
  assert.equal(due[0].amount, 99);
});

test('dueThisPeriod: annual plan not yet recorded this year IS due', () => {
  const subs = [{ _id: 'x', status: 'active', brand: 'atom', companyName: 'Y', amount: 1200, cadence: 'annual', startedAt: '2026-01-05', periods: [] }];
  const due = dueThisPeriod(subs, TODAY);
  assert.deepEqual(due.map((d) => d.id), ['x']);
  assert.equal(due[0].period, '2026');
});

test('brand vocabulary: recurring subset is webworks + atom; labels resolve', () => {
  assert.deepEqual(SUBSCRIPTION_BRAND_KEYS, ['webworks', 'atom']);
  assert.ok(BRAND_KEYS.includes('contact'));   // Joint Printing is a brand, just not subscription
  assert.equal(brandLabel('webworks'), 'JP Webworks');
  assert.equal(brandLabel('atom'), 'JP Atom');
  assert.equal(brandLabel('contact'), 'Joint Printing');
  assert.equal(brandLabel('nope'), '');
  assert.equal(isBrand('atom'), true);
  assert.equal(isBrand('nope'), false);
});
