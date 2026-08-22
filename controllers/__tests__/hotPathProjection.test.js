// controllers/__tests__/hotPathProjection.test.js
//   node --test controllers/__tests__/hotPathProjection.test.js
//
// Two hot-path reads used to return whole documents.
//
// `GET /api/crm/clients` is the CRM's main read, fired on every load, and it
// returned every field of every client — including `log[]`, which grows without
// bound and on a worked account is most of the document. Nothing in the list
// renders a log entry.
//
// `GET /api/outreach/analytics` pulled every enrollment ever made, each carrying
// a `sends[]` that grows for the life of the sequence — subject line and
// Message-ID included, neither of which any funnel, trend or A/B split reads.
//
// These pin the projections. They are cheap and they are the kind of thing that
// silently regresses the next time a field is added.

const test = require('node:test');
const assert = require('node:assert/strict');

const { _LIST_FIELDS, _hasOwnerTouch } = require('../crm');
const { _ANALYTICS_OMIT } = require('../outreach');

const fields = _LIST_FIELDS.split(/\s+/).filter(Boolean);

test('the companies list does not pull log[] — the unbounded field', () => {
  assert.ok(!fields.includes('log'), 'log[] must not be in the list projection');
});

test('the companies list still pulls everything the list actually renders', () => {
  for (const f of ['companyKey', 'companyName', 'stage', 'tags', 'nextFollowUp',
    'lastContact', 'dealValue', 'contacts', 'area', 'leadSource', 'archived']) {
    assert.ok(fields.includes(f), `${f} is rendered/filtered by the list and must be projected`);
  }
});

// The reason log[] could not simply be dropped.
test('ownerTouched: a logged call/text/visit is an owner touch', () => {
  for (const kind of ['call', 'text', 'visit']) {
    assert.equal(_hasOwnerTouch({ log: [{ kind }] }), true, `${kind} counts`);
  }
});

test('ownerTouched: an automated email is NOT an owner touch', () => {
  assert.equal(_hasOwnerTouch({ log: [{ kind: 'email' }] }), false);
});

test('ownerTouched: no log, junk log, missing record → false, never a throw', () => {
  assert.equal(_hasOwnerTouch({}), false);
  assert.equal(_hasOwnerTouch(null), false);
  assert.equal(_hasOwnerTouch({ log: [null, undefined, 0] }), false);
});

test('outreach analytics omits the per-send heavy strings', () => {
  assert.ok(_ANALYTICS_OMIT.includes('-sends.subject'));
  assert.ok(_ANALYTICS_OMIT.includes('-sends.messageId'));
});

test('outreach analytics never pulls the recipient unsubscribe token', () => {
  assert.ok(_ANALYTICS_OMIT.includes('-token'),
    'the unsubscribe credential has no business in a rollup');
});

test('outreach analytics KEEPS the four send fields the funnel reads', () => {
  for (const kept of ['sends.stepIndex', 'sends.at', 'sends.openedAt', 'sends.variant']) {
    assert.ok(!_ANALYTICS_OMIT.includes(`-${kept}`), `${kept} is read by the funnel`);
  }
});
