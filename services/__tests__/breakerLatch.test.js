// services/__tests__/breakerLatch.test.js
//
// The owner watched five hard bounces land in nine sends one morning, right
// after the engine resumed on its own. It resumed because the BOUNCES AGED OUT
// of the 7-day window — not because anything about the list had changed.
//
// A held engine sends nothing, so both sides of the rate decay: bounced7d falls
// under the minimum, sent7d falls to zero (and bounceRate is defined as 0 when
// it does). Either one clears the trip. Then it sends into the identical
// roster, bounces, and trips again — a flap that costs real domain reputation
// every cycle.
//
//   node --test services/__tests__/breakerLatch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateDeliverability } = require('../outreachEngine');

test('a fresh, bad list trips the breaker', () => {
  const v = evaluateDeliverability({ sent7d: 163, bounced7d: 21 });
  assert.equal(v.tripped, true);
  assert.ok(v.bounceRate > 0.05);
});

test('a hold does NOT lift because the bounces aged out', () => {
  // Held for days: the old bounces have rolled out of the window and almost
  // nothing was sent. Under the old rule bounced7d < BREAKER_MIN_BOUNCES made
  // rateIsBad false and the brake lifted on a list nobody had fixed.
  const v = evaluateDeliverability({ sent7d: 4, bounced7d: 1, alreadyHeld: true });
  assert.equal(v.tripped, true, 'a thin sample must not end a hold');
});

test('a hold does NOT lift when the window empties completely', () => {
  // sent7d 0 makes bounceRate 0 by definition — the most misleading possible
  // reading, since it means "we stopped sending", not "we stopped bouncing".
  const v = evaluateDeliverability({ sent7d: 0, bounced7d: 0, alreadyHeld: true });
  assert.equal(v.bounceRate, 0);
  assert.equal(v.tripped, true, 'an empty window is not evidence of health');
});

test('the hold message stops promising it will resume by itself', () => {
  const v = evaluateDeliverability({ sent7d: 0, bounced7d: 0, alreadyHeld: true });
  assert.doesNotMatch(v.reason, /resumes on its own/i);
  assert.match(v.reason, /deliberately|resume it/i);
});

test('a full fresh CLEAN sample does release the hold', () => {
  // This is the positive evidence the latch waits for — and the reason it is a
  // latch rather than a permanent stop.
  const v = evaluateDeliverability({ sent7d: 60, bounced7d: 0, alreadyHeld: true });
  assert.equal(v.tripped, false);
});

test('a full fresh sample that is STILL bad keeps the hold', () => {
  const v = evaluateDeliverability({ sent7d: 60, bounced7d: 20, alreadyHeld: true });
  assert.equal(v.tripped, true);
});

test('a not-yet-held engine is unaffected by the latch', () => {
  // The sample floor still governs the FIRST trip: three bounces in a 30-send
  // test must not pause a healthy engine.
  const v = evaluateDeliverability({ sent7d: 30, bounced7d: 3 });
  assert.equal(v.tripped, false);
});

test('clearing the hold is deliberate and does not send anything', () => {
  const src = require('fs').readFileSync(require.resolve('../outreachEngine'), 'utf8');
  const fn = src.match(/async function clearSendingHold[\s\S]*?\n}\n/);
  assert.ok(fn, 'clearSendingHold not found');
  // It resets the flag the latch reads, and nothing else. It must never bypass
  // the rate test — a still-bad list has to re-trip on real numbers.
  assert.match(fn[0], /last_result/);
  assert.doesNotMatch(fn[0], /sendOne|runOutreachTick|transport/);
});
