// The "Fix data" detection that un-does the fuzzy matcher's residue.
//
// The Order Tracker used to attach mockups to a project by company-NAME
// similarity and silently persist those matches into order.mockupNumbers on
// every drawer open. A client with many projects ended up with every project
// holding every mockup they had ever had, and a pre-confirmation approval link
// showed the client that whole pile. The matcher is gone; this detector proposes
// removing what it left behind.
//
// It touches live data, so the bar is: never propose removing an intentional
// link. Every test below is a case where the answer must be "leave it alone".

const test = require('node:test');
const assert = require('node:assert');

const { detectCrossProjectMockups } = require('../dataCleanup');

const order = (over = {}) => ({
  _id: 'o1', projectNumber: '150', orderNumber: '1050',
  companyName: 'Happy Leaf Dispensary', mockupNumbers: [], ...over,
});

test('flags a mockup whose base names a different project', () => {
  const out = detectCrossProjectMockups(
    [order({ mockupNumbers: ['#000150A', '#000120B'] })],
    new Map(),
  );
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].foreign.map((f) => f.mockupNum), ['#000120B']);
  assert.deepStrictEqual(out[0].keep, ['#000150A'], 'the project keeps its own work');
});

test('leaves a clean project completely alone', () => {
  const out = detectCrossProjectMockups(
    [order({ mockupNumbers: ['#000150A', '#000150B', '#000150A2'] })],
    new Map(),
  );
  assert.deepStrictEqual(out, [], 'nothing to fix → the tool auto-hides');
});

test('never removes a mockup the confirmation references', () => {
  // The owner put it on the confirmation the client is reviewing. Whatever its
  // number says, that is a deliberate act and outranks the base check.
  const out = detectCrossProjectMockups(
    [order({
      mockupNumbers: ['#000120B'],
      confirmation: { items: [{ mockupNum: '#000120B' }] },
    })],
    new Map(),
  );
  assert.deepStrictEqual(out, []);
});

test('never removes a mockup deliberately carried into this project', () => {
  const owners = new Map([['120B', { projectNumber: '150', carriedInto: '150' }]]);
  const out = detectCrossProjectMockups(
    [order({ mockupNumbers: ['#000120B'] })],
    owners,
  );
  assert.deepStrictEqual(out, [], 'carry-over is an explicit action, not residue');
});

test('a carry-over into a DIFFERENT project is still foreign here', () => {
  const owners = new Map([['120B', { projectNumber: '200', carriedInto: '200' }]]);
  const out = detectCrossProjectMockups([order({ mockupNumbers: ['#000120B'] })], owners);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].foreign[0].belongsTo, '200', 'reports where it really lives');
});

test('matches numbers regardless of # and leading-zero formatting', () => {
  const out = detectCrossProjectMockups(
    [order({ projectNumber: '150', mockupNumbers: ['150A', '#000150B', '000150C', '120D'] })],
    new Map(),
  );
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].foreign.map((f) => f.mockupNum), ['120D']);
  assert.deepStrictEqual(out[0].keep, ['150A', '#000150B', '000150C']);
});

test('sibling projects share a base and are not cross-project', () => {
  // '22-1' and '22-2' both base to 000022 — a number under that base is not
  // evidence of pollution, so the detector must not touch it.
  const out = detectCrossProjectMockups(
    [order({ projectNumber: '22-2', mockupNumbers: ['#000022A', '#000022B'] })],
    new Map(),
  );
  assert.deepStrictEqual(out, []);
});

test('ignores orders with no project number to compare against', () => {
  const out = detectCrossProjectMockups(
    [order({ projectNumber: '', mockupNumbers: ['#000120B'] })],
    new Map(),
  );
  assert.deepStrictEqual(out, [], 'an empty shell is not evidence of anything');
});

test('ignores unparseable promo numbers rather than guessing', () => {
  const out = detectCrossProjectMockups(
    [order({ mockupNumbers: ['#000150A', 'Plastic Grinder', ''] })],
    new Map(),
  );
  assert.deepStrictEqual(out, []);
});

test('handles empty and missing input without throwing', () => {
  assert.deepStrictEqual(detectCrossProjectMockups([], new Map()), []);
  assert.deepStrictEqual(detectCrossProjectMockups(null, null), []);
  assert.deepStrictEqual(detectCrossProjectMockups([order()], null), []);
});

test('the real shape: one client, many projects, all cross-linked', () => {
  // What the fuzzy matcher actually produced — every project holding every
  // mockup of the client. Each project should come back holding only its own.
  const all = ['#000150A', '#000150B', '#000160A', '#000170A', '#000170B'];
  const orders = [
    order({ _id: 'a', projectNumber: '150', mockupNumbers: [...all] }),
    order({ _id: 'b', projectNumber: '160', mockupNumbers: [...all] }),
    order({ _id: 'c', projectNumber: '170', mockupNumbers: [...all] }),
  ];
  const out = detectCrossProjectMockups(orders, new Map());
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.find((o) => o.orderId === 'a').keep, ['#000150A', '#000150B']);
  assert.deepStrictEqual(out.find((o) => o.orderId === 'b').keep, ['#000160A']);
  assert.deepStrictEqual(out.find((o) => o.orderId === 'c').keep, ['#000170A', '#000170B']);
  // Nothing is lost overall — every mockup still lives on exactly one project.
  const kept = out.flatMap((o) => o.keep).sort();
  assert.deepStrictEqual(kept, [...all].sort());
});

test('is idempotent — a second run on cleaned data finds nothing', () => {
  const first = detectCrossProjectMockups(
    [order({ mockupNumbers: ['#000150A', '#000120B'] })], new Map(),
  );
  const cleaned = order({ mockupNumbers: first[0].keep });
  assert.deepStrictEqual(detectCrossProjectMockups([cleaned], new Map()), []);
});
