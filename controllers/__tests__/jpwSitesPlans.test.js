// Webworks is a SUBSCRIPTION business, but the sites list only ever knew whether
// a site was live — never whether it was earning. Subscription carried `siteId`
// and `companyKey` for this join the whole time and nothing read either.
//
// The behaviour that matters: an explicit siteId link always beats a company
// guess, a guess is REPORTED as a guess rather than passed off as fact, and
// "have I billed this period" comes from the same helper the Finances checklist
// uses so the two surfaces can never disagree.

const test = require('node:test');
const assert = require('node:assert');

const { attachPlans } = require('../jpwSites');

const TODAY = new Date('2026-07-25T12:00:00Z'); // period '2026-07'

const site = (over = {}) => ({ _id: 's1', name: 'Cape May Brewing', companyKey: 'capemaybrewing', edits: [], ...over });
const sub = (over = {}) => ({
  _id: 'sub1', companyKey: 'capemaybrewing', brand: 'webworks', plan: 'Care Plan',
  amount: 99, cadence: 'monthly', status: 'active', startedAt: new Date('2026-01-10T00:00:00Z'),
  nextBillDate: new Date('2026-08-01T00:00:00Z'), periods: [], siteId: null, ...over,
});

test('a site with no plan reports plan: null — it is not earning', () => {
  const [out] = attachPlans([site()], [], TODAY);
  assert.strictEqual(out.plan, null);
});

test('an explicitly linked plan is reported as linkedBy: site', () => {
  const [out] = attachPlans([site()], [sub({ siteId: 's1' })], TODAY);
  assert.strictEqual(out.plan.linkedBy, 'site');
  assert.strictEqual(out.plan.amount, 99);
  assert.strictEqual(out.plan.label, 'Care Plan');
});

test('a company match is reported as a guess, not as fact', () => {
  // The site was built before siteId existed. Show the money, but mark it.
  const [out] = attachPlans([site()], [sub()], TODAY);
  assert.strictEqual(out.plan.linkedBy, 'company');
});

test('the explicit siteId link wins over a different company plan', () => {
  const subs = [
    sub({ _id: 'wrong', plan: 'Old Plan', amount: 49 }),           // company-only
    sub({ _id: 'right', plan: 'New Plan', amount: 149, siteId: 's1' }), // explicit
  ];
  const [out] = attachPlans([site()], subs, TODAY);
  assert.strictEqual(out.plan.id, 'right');
  assert.strictEqual(out.plan.amount, 149);
});

test('an ACTIVE plan beats a canceled one for the company fallback', () => {
  const subs = [
    sub({ _id: 'dead', status: 'canceled', amount: 49 }),
    sub({ _id: 'live', status: 'active', amount: 99 }),
  ];
  const [out] = attachPlans([site()], subs, TODAY);
  assert.strictEqual(out.plan.id, 'live');

  // …and order must not decide it.
  const [rev] = attachPlans([site()], subs.slice().reverse(), TODAY);
  assert.strictEqual(rev.plan.id, 'live');
});

test('a paused plan still shows — the site is live and NOT being billed', () => {
  // Silence here is the failure mode: a paused plan is exactly what you want to see.
  const [out] = attachPlans([site()], [sub({ status: 'paused', siteId: 's1' })], TODAY);
  assert.strictEqual(out.plan.status, 'paused');
});

test('recordedThisPeriod answers "have I billed this month"', () => {
  const unbilled = attachPlans([site()], [sub({ siteId: 's1' })], TODAY)[0];
  assert.strictEqual(unbilled.plan.currentPeriod, '2026-07');
  assert.strictEqual(unbilled.plan.recordedThisPeriod, false);

  const billed = attachPlans([site()],
    [sub({ siteId: 's1', periods: [{ period: '2026-07', status: 'recorded' }] })], TODAY)[0];
  assert.strictEqual(billed.plan.recordedThisPeriod, true);
});

test('a period recorded LAST month does not count as this month', () => {
  // The exact way "I already billed them" goes wrong.
  const [out] = attachPlans([site()],
    [sub({ siteId: 's1', periods: [{ period: '2026-06', status: 'recorded' }] })], TODAY);
  assert.strictEqual(out.plan.recordedThisPeriod, false);
});

test('a SKIPPED period is not a recorded one', () => {
  const [out] = attachPlans([site()],
    [sub({ siteId: 's1', periods: [{ period: '2026-07', status: 'skipped' }] })], TODAY);
  assert.strictEqual(out.plan.recordedThisPeriod, false);
});

test('an annual plan keys off its anniversary, not the calendar year', () => {
  // Started Jan 10; on Jul 25 2026 the current annual period is 2026.
  const [out] = attachPlans([site()],
    [sub({ siteId: 's1', cadence: 'annual', amount: 990 })], TODAY);
  assert.strictEqual(out.plan.cadence, 'annual');
  assert.strictEqual(out.plan.currentPeriod, '2026');
});

test('openEdits still counts only unfinished edits', () => {
  const [out] = attachPlans(
    [site({ edits: [{ status: 'done' }, { status: 'open' }, { status: 'in_progress' }] })], [], TODAY,
  );
  assert.strictEqual(out.openEdits, 2);
});

test('a site with no companyKey never picks up someone else\'s plan', () => {
  const [out] = attachPlans([site({ companyKey: '' })], [sub()], TODAY);
  assert.strictEqual(out.plan, null);
});

test('sites keep their own fields and each other\'s plans stay separate', () => {
  const sites = [site(), site({ _id: 's2', name: 'Other Co', companyKey: 'otherco' })];
  const subs = [sub({ siteId: 's1', amount: 99 }), sub({ _id: 'sub2', companyKey: 'otherco', amount: 199 })];
  const out = attachPlans(sites, subs, TODAY);
  assert.strictEqual(out[0].name, 'Cape May Brewing');
  assert.strictEqual(out[0].plan.amount, 99);
  assert.strictEqual(out[1].plan.amount, 199);
  assert.strictEqual(out[1].plan.linkedBy, 'company');
});

test('handles empty and missing input', () => {
  assert.deepStrictEqual(attachPlans([], [], TODAY), []);
  assert.deepStrictEqual(attachPlans(null, null, TODAY), []);
});
