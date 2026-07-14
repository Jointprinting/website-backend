const { test } = require('node:test');
const assert = require('node:assert');
const { finalLegFor, UPS_NUM_RE } = require('../upsTracking');

const step = (over) => ({ id: '', label: '', link: '', hidden: false, completedAt: null, note: '', ...over });
const order = (status, steps) => ({ status, tracking: { steps } });

test('UPS_NUM_RE finds 1Z numbers inside carrier URLs and raw pastes', () => {
  assert.ok(UPS_NUM_RE.test('https://www.ups.com/track?tracknum=1Z999AA10123456784'));
  assert.ok(UPS_NUM_RE.test('1z999aa10123456784'));
  assert.ok(!UPS_NUM_RE.test('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400'));
});

test('finalLegFor: blanks-shipping link never delivers an in-production order', () => {
  const o = order('in_production', [
    step({ id: 'blanks_shipping', label: 'Blanks shipping', link: 'https://ups.com/track?tracknum=1Z999AA10123456784' }),
  ]);
  assert.strictEqual(finalLegFor(o), null);
});

test('finalLegFor: delivery-labelled step counts regardless of status', () => {
  const o = order('in_production', [
    step({ id: 'blanks_shipping', label: 'Blanks shipping', link: 'https://ups.com/track?tracknum=1Z111AA10123456784' }),
    step({ id: 'custom-1', label: 'On the way to you', link: 'https://ups.com/track?tracknum=1Z999AA10123456784' }),
  ]);
  const leg = finalLegFor(o);
  assert.ok(leg);
  assert.strictEqual(leg.num, '1Z999AA10123456784');
  assert.strictEqual(leg.step.label, 'On the way to you');
});

test('finalLegFor: a shipped order trusts its LAST non-hidden linked step', () => {
  const o = order('shipped', [
    step({ id: 'blanks_shipping', label: 'Blanks shipping', link: 'https://ups.com/track?tracknum=1Z111AA10123456784' }),
    step({ id: 'custom-2', label: 'Final leg', link: 'https://ups.com/track?tracknum=1Z999AA10123456784' }),
    step({ id: 'custom-3', label: 'Hidden extra', link: 'https://ups.com/track?tracknum=1Z222AA10123456784', hidden: true }),
  ]);
  const leg = finalLegFor(o);
  assert.ok(leg);
  assert.strictEqual(leg.num, '1Z999AA10123456784');
});

test('finalLegFor: no UPS link → null', () => {
  const o = order('shipped', [step({ label: 'On the way to you', link: 'https://usps.com/whatever' })]);
  assert.strictEqual(finalLegFor(o), null);
});
