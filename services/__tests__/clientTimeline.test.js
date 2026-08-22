// services/__tests__/clientTimeline.test.js
//   node --test services/__tests__/clientTimeline.test.js
//
// The owner's ask: "the states clients are in, from talking to the client to
// placing the order." The events already existed — scattered across seven
// append-only logs that never met. This merges them.
//
// The interesting behaviour is at the seams: two sources describing the same
// moment, a note logged after delivery, junk rows, and the fact that a client
// on the books for years must show their FULL history on the first load.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fromClientLog, fromOrder, fromPurchaseOrders, fromOutreach, fromReplies,
  fromSubmissions, fromFieldRuns, mergeTimeline, summarize, PHASES,
} = require('../clientTimeline');

const D = (s) => new Date(s);

test('the CRM touch log becomes conversation events, keeping who did it', () => {
  const out = fromClientLog({ log: [
    { at: D('2026-01-05'), kind: 'call', text: 'Left a voicemail', by: 'mike' },
    { at: D('2026-01-06'), kind: 'visit', text: 'Dropped samples' },
  ] });
  assert.equal(out.length, 2);
  assert.equal(out[0].phase, 'conversation');
  assert.equal(out[0].title, 'Left a voicemail');
  assert.equal(out[0].actor, 'mike');
});

test('an unknown log kind degrades to a note rather than vanishing', () => {
  const out = fromClientLog({ log: [{ at: D('2026-01-05'), kind: 'carrier-pigeon', text: 'hi' }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'note');
});

test('a log entry with no timestamp is dropped — it cannot sit on a timeline', () => {
  assert.equal(fromClientLog({ log: [{ kind: 'call', text: 'when?' }] }).length, 0);
});

test('an order contributes its activity AND the milestones stored as bare dates', () => {
  const out = fromOrder({
    projectNumber: 'P-100', orderNumber: '1042', totalValue: 4200,
    createdAt: D('2026-02-01'),
    activity: [{ at: D('2026-02-03'), kind: 'quote_published', message: 'Quote sent', actor: 'admin' }],
    orderDate: D('2026-02-10'), shipDate: D('2026-02-20'), deliveredDate: D('2026-02-22'),
    closeout: { at: D('2026-02-25'), rating: 4, onTime: true, reprintQty: 2 },
  });
  const kinds = out.map((e) => e.kind);
  for (const k of ['order_created', 'quote_activity', 'order_placed', 'shipped', 'delivered', 'closeout']) {
    assert.ok(kinds.includes(k), `${k} must appear`);
  }
  const placed = out.find((e) => e.kind === 'order_placed');
  assert.match(placed.title, /Order 1042 placed/);
  assert.match(placed.title, /\$4,200/);
  const close = out.find((e) => e.kind === 'closeout');
  assert.equal(close.detail, '4/5 · on time · 2 reprinted');
});

test('a project with no order number never claims an order was placed', () => {
  const out = fromOrder({ projectNumber: 'P-1', createdAt: D('2026-02-01'), orderDate: D('2026-02-10') });
  assert.equal(out.filter((e) => e.kind === 'order_placed').length, 0);
});

test('closeout onTime:false reads as late, and onTime null says neither', () => {
  const late = fromOrder({ createdAt: D('2026-01-01'), closeout: { at: D('2026-02-01'), onTime: false } });
  assert.match(late.find((e) => e.kind === 'closeout').detail, /late/);
  const unknown = fromOrder({ createdAt: D('2026-01-01'), closeout: { at: D('2026-02-01'), onTime: null } });
  assert.equal(unknown.find((e) => e.kind === 'closeout').detail, '');
});

test('a cold send and its open are two events, because they are two moments', () => {
  const out = fromOutreach([{ toEmail: 'a@b.com', sends: [
    { stepIndex: 0, at: D('2026-01-02T10:00:00Z'), openedAt: D('2026-01-02T14:00:00Z') },
  ] }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.kind).sort(), ['outreach_opened', 'outreach_sent']);
});

test('a reply carries who sent it and how it was classified', () => {
  const out = fromReplies([{ receivedAt: D('2026-01-03'), subject: 'Re: quote', fromName: 'Dana', category: 'interested' }]);
  assert.equal(out[0].phase, 'conversation');
  assert.equal(out[0].actor, 'Dana');
  assert.equal(out[0].detail, 'interested');
});

test('the contact form that started it all is the inbound phase', () => {
  const out = fromSubmissions([{ createdAt: D('2026-01-01'), name: 'Dana', quantity: 150, inHandDate: 'Mar 1', source: 'website' }]);
  assert.equal(out[0].phase, 'inbound');
  assert.equal(out[0].detail, '150 units · needs Mar 1');
});

test('field stops only count for THIS company', () => {
  const runs = [{ stops: [
    { companyKey: 'acme', name: 'Acme', visitedAt: D('2026-01-04'), outcome: 'talked to owner' },
    { companyKey: 'other', name: 'Other', visitedAt: D('2026-01-04') },
  ] }];
  const out = fromFieldRuns(runs, 'acme');
  assert.equal(out.length, 1);
  assert.equal(out[0].detail, 'talked to owner');
});

test('a stop never visited is not an event', () => {
  assert.equal(fromFieldRuns([{ stops: [{ companyKey: 'acme', name: 'Acme' }] }], 'acme').length, 0);
});

test('PO lifecycle events land on the timeline with their vendor', () => {
  const out = fromPurchaseOrders([{ poNumber: 'PO-9', vendorKey: 'heritage', orderNumber: '1042',
    events: [{ at: D('2026-02-12'), kind: 'sent' }] }]);
  assert.equal(out[0].phase, 'order');
  assert.match(out[0].title, /PO-9/);
  assert.equal(out[0].detail, 'heritage');
});

test('the merged stream is newest first', () => {
  const merged = mergeTimeline(
    fromClientLog({ log: [{ at: D('2026-01-05'), kind: 'call', text: 'Called' }] }),
    fromSubmissions([{ createdAt: D('2026-01-01'), name: 'Dana' }]),
    fromReplies([{ receivedAt: D('2026-01-03'), subject: 'Re:' }]),
  );
  const times = merged.map((e) => e.at.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.equal(merged.length, 3);
});

test('two sources describing the same minute collapse to one, keeping the richer row', () => {
  const a = { at: D('2026-01-05T10:00:10Z'), kind: 'reply', phase: 'conversation', label: 'x', title: 'Re: quote', detail: '' };
  const b = { at: D('2026-01-05T10:00:50Z'), kind: 'reply', phase: 'conversation', label: 'x', title: 'Re: quote', detail: 'interested' };
  const merged = mergeTimeline([a], [b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].detail, 'interested', 'the row with more to say survives');
});

test('different minutes are different events, even with the same title', () => {
  const a = { at: D('2026-01-05T10:00:00Z'), kind: 'call', phase: 'conversation', label: 'Call', title: 'Called', detail: '' };
  const b = { at: D('2026-01-05T10:30:00Z'), kind: 'call', phase: 'conversation', label: 'Call', title: 'Called', detail: '' };
  assert.equal(mergeTimeline([a], [b]).length, 2);
});

test('summarize: the current phase is the FURTHEST reached, not the latest event', () => {
  // A note logged after delivery must not read as "we are back to chatting".
  const events = mergeTimeline(
    fromOrder({ projectNumber: 'P', orderNumber: '1', createdAt: D('2026-01-01'),
      orderDate: D('2026-02-01'), deliveredDate: D('2026-03-01') }),
    fromClientLog({ log: [{ at: D('2026-04-01'), kind: 'note', text: 'thanked them' }] }),
  );
  assert.equal(summarize(events).currentPhase, 'order');
});

test('summarize: first and last touch span the whole relationship', () => {
  const s = summarize(mergeTimeline(
    fromSubmissions([{ createdAt: D('2026-01-01'), name: 'Dana' }]),
    fromClientLog({ log: [{ at: D('2026-06-01'), kind: 'call', text: 'Called' }] }),
  ));
  assert.equal(s.firstTouch.toISOString().slice(0, 10), '2026-01-01');
  assert.equal(s.lastTouch.toISOString().slice(0, 10), '2026-06-01');
  assert.equal(s.counts.call, 1);
  assert.equal(s.phaseCounts.inbound, 1);
});

test('summarize: an empty timeline reports nulls, never a confident zero', () => {
  const s = summarize([]);
  assert.equal(s.currentPhase, null);
  assert.equal(s.firstTouch, null);
  assert.equal(s.daysSinceLastTouch, null);
});

test('junk in every source: nulls, undefined, missing arrays — never throws', () => {
  assert.doesNotThrow(() => {
    mergeTimeline(
      fromClientLog(null), fromClientLog({ log: [null, undefined] }),
      fromOrder(null), fromOrder({}),
      fromPurchaseOrders([null, { events: [null] }]),
      fromOutreach([null, { sends: null }]),
      fromReplies([null]), fromSubmissions([null]),
      fromFieldRuns([null, { stops: [null] }], 'acme'),
    );
  });
});

test('every declared kind maps to a real phase', () => {
  const { KINDS } = require('../clientTimeline');
  for (const [kind, spec] of Object.entries(KINDS)) {
    assert.ok(PHASES.includes(spec.phase), `${kind} → unknown phase ${spec.phase}`);
  }
});

// ---------------------------------------------------------------------------
// SYNC GUARD — the twin of src/screens/studio/crm/_timeline.sync.test.js in the
// frontend. The phase vocabulary is defined here and mirrored there so the Studio
// panel can label and colour each event. A drifted mirror renders an event with
// no label and no colour, which reads as a rendering bug rather than as the
// missing case it is. Both sides are pinned to the same agreed literals: change
// one without the other and one suite goes red.
// ---------------------------------------------------------------------------

test('PHASES mirrors the frontend _timeline.js (order matters — it is the arc)', () => {
  assert.deepEqual(PHASES, ['inbound', 'outreach', 'conversation', 'quote', 'order', 'aftercare']);
});

test('every event kind resolves to a declared phase — no kind can render unlabelled', () => {
  const { KINDS } = require('../clientTimeline');
  const kinds = Object.keys(KINDS);
  assert.ok(kinds.length >= 15, 'the taxonomy should cover the whole arc');
  for (const k of kinds) {
    assert.ok(PHASES.includes(KINDS[k].phase), `${k} → unknown phase`);
    assert.ok(KINDS[k].label && KINDS[k].label.length, `${k} has no label`);
  }
});
