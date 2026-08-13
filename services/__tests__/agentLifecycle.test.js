// services/__tests__/agentLifecycle.test.js
//
// The onboarding checklist is a GATE, not a to-do list — these tests pin the
// two things that makes true: a later stage cannot open while an earlier one has
// required work outstanding, and the pay/sell gates refuse for a stated reason.
//
//   node --test services/__tests__/agentLifecycle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STAGES, STEP_KEYS, normalizeCompletions, checklistFor, gates, impliedStatus,
} = require('../agentLifecycle');

const at = (k, extra = {}) => ({ [k]: { doneAt: new Date('2026-01-05'), by: 'studio', ...extra } });
const withSteps = (...keys) => ({ onboarding: Object.assign({}, ...keys.map((k) => at(k))) });

// ── shape ────────────────────────────────────────────────────────────────────

test('stage and step keys are unique — they are the persisted identity', () => {
  assert.equal(new Set(STAGES.map((s) => s.key)).size, STAGES.length);
  assert.equal(new Set(STEP_KEYS).size, STEP_KEYS.length);
});

test('normalizeCompletions tolerates a Map, a plain object, and junk', () => {
  const d = new Date('2026-02-01');
  assert.equal(normalizeCompletions(new Map([['w9_received', { doneAt: d }]])).w9_received.doneAt.getTime(), d.getTime());
  assert.equal(normalizeCompletions({ w9_received: { doneAt: d } }).w9_received.doneAt.getTime(), d.getTime());
  assert.deepEqual(normalizeCompletions(null), {});
  assert.deepEqual(normalizeCompletions(undefined), {});
});

test('normalizeCompletions drops keys that are not real steps', () => {
  const out = normalizeCompletions({ w9_received: { doneAt: new Date() }, made_up_step: { doneAt: new Date() } });
  assert.ok(out.w9_received);
  assert.equal(out.made_up_step, undefined, 'a renamed/removed step cannot resurrect as a phantom tick');
});

test('normalizeCompletions ignores an unparseable date rather than storing Invalid Date', () => {
  assert.deepEqual(normalizeCompletions({ w9_received: { doneAt: 'not-a-date' } }), {});
});

// ── the gate behaviour ───────────────────────────────────────────────────────

test('a fresh agent has everything locked past the first stage', () => {
  const c = checklistFor({});
  assert.equal(c.stages[0].locked, false, 'the first stage is always open');
  assert.equal(c.stages[1].locked, true);
  assert.equal(c.stages[2].locked, true);
  assert.equal(c.complete, false);
  assert.equal(c.requiredDone, 0);
});

test('finishing a stage unlocks exactly the next one, not all of them', () => {
  const c = checklistFor(withSteps('screened', 'rates_agreed'));
  assert.equal(c.stages[0].complete, true);
  assert.equal(c.stages[1].locked, false, 'paperwork opens');
  assert.equal(c.stages[2].locked, true, 'accounts stays shut until paperwork is done');
});

test('an OPTIONAL step never blocks the next stage', () => {
  // coi_received is optional; agreement + w9 are the required pair.
  const c = checklistFor(withSteps('screened', 'rates_agreed', 'agreement_signed', 'w9_received'));
  assert.equal(c.stages[1].complete, true, 'missing the optional COI does not block');
  assert.equal(c.stages[2].locked, false);
});

test('progress counts required steps only', () => {
  const c = checklistFor(withSteps('screened'));
  assert.ok(c.progress > 0 && c.progress < 1);
  assert.equal(c.requiredTotal, STAGES.flatMap((s) => s.steps).filter((s) => s.required).length);
});

// ── the money/authority gates ────────────────────────────────────────────────

test('nobody may sell without a signed agreement, and the refusal says why', () => {
  const g = gates({});
  assert.equal(g.maySell.ok, false);
  assert.match(g.maySell.why, /signed agreement/i);

  const signed = gates(withSteps('agreement_signed'));
  assert.equal(signed.maySell.ok, true);
  assert.equal(signed.maySell.why, '');
});

test('nobody may be PAID without a W-9 — the backup-withholding trap', () => {
  const g = gates(withSteps('agreement_signed'));
  assert.equal(g.mayBePaid.ok, false);
  assert.match(g.mayBePaid.why, /W-9/);
  assert.match(g.mayBePaid.why, /24%/, 'the refusal names the actual consequence');

  assert.equal(gates(withSteps('agreement_signed', 'w9_received')).mayBePaid.ok, true);
});

test('a W-9 alone is not enough to be paid — terms have to exist too', () => {
  const g = gates(withSteps('w9_received'));
  assert.equal(g.mayBePaid.ok, false);
  assert.match(g.mayBePaid.why, /agreement/i);
});

test('commission cannot be switched on before rates are agreed', () => {
  const paperworkOnly = gates(withSteps('agreement_signed', 'w9_received'));
  assert.equal(paperworkOnly.mayEnableCommission.ok, false);
  assert.match(paperworkOnly.mayEnableCommission.why, /rates/i);

  const ready = gates(withSteps('rates_agreed', 'agreement_signed', 'w9_received'));
  assert.equal(ready.mayEnableCommission.ok, true);
});

// ── status derivation ────────────────────────────────────────────────────────

test('impliedStatus follows the facts, so status and access cannot drift apart', () => {
  assert.equal(impliedStatus({}), 'onboarding');
  assert.equal(impliedStatus({ active: false }), 'paused');
  assert.equal(impliedStatus({ departedAt: new Date() }), 'departed');
  assert.equal(
    impliedStatus({ departedAt: new Date(), active: true }), 'departed',
    'departed beats an account someone forgot to switch off',
  );
});

test('impliedStatus only says "active" once every required step is done', () => {
  const allRequired = STAGES.flatMap((s) => s.steps).filter((s) => s.required).map((s) => s.key);
  assert.equal(impliedStatus(withSteps(...allRequired)), 'active');
  assert.equal(impliedStatus(withSteps(...allRequired.slice(0, -1))), 'onboarding');
});

test('the W-9 step tells the owner NOT to upload the document', () => {
  // The refusal to store an SSN is a product decision; it must survive edits.
  const w9 = STAGES.flatMap((s) => s.steps).find((s) => s.key === 'w9_received');
  assert.match(w9.help, /do not upload/i);
});
