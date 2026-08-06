// services/__tests__/sendWindowTz.test.js
//
// Sending in the RECIPIENT's morning, not ours.
//
// The window used to be one Eastern block for the whole country. On a national
// list that's wrong in both directions: 9am Eastern reaches a Colorado shop at
// 7am and a California shop at 6am — before anyone is at the counter — and
// closing at 5pm Eastern abandons the entire West Coast afternoon while it's
// still mid-morning there. It also meant the Studio told an owner working from
// Mountain time that sending was "closed" at 3pm his time.
//
//   node --test services/__tests__/sendWindowTz.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isWithinSendWindowFor, isWithinSendWindow, openZones, nextWindowOpen, windowMinutesLeft,
} = require('../outreachEngine');
const { tzForState, zoneLabel } = require('../../utils/usTimezones');

// 2026-08-06 is a Thursday. 21:00Z = 5pm ET / 4pm CT / 3pm MT / 2pm PT.
const AT = (iso) => new Date(iso);

test('a lead is judged in its own local hours', () => {
  const t = AT('2026-08-06T13:30:00Z');          // 9:30am ET, 6:30am PT
  assert.equal(isWithinSendWindowFor('MI', t), true);   // Michigan is at work
  assert.equal(isWithinSendWindowFor('CA', t), false);  // California is asleep
});

test('the West Coast keeps working after Eastern closes', () => {
  const t = AT('2026-08-06T22:00:00Z');          // 6pm ET, 3pm PT
  assert.equal(isWithinSendWindowFor('MI', t), false);
  assert.equal(isWithinSendWindowFor('CO', t), true);
  assert.equal(isWithinSendWindowFor('CA', t), true);
  // …which is exactly the case the old single-Eastern gate threw away.
  assert.equal(isWithinSendWindow(t), true);
});

test('Arizona does not observe DST, and the zone map handles it', () => {
  // In August, Phoenix is UTC-7 (same clock as Pacific), NOT UTC-6 like Denver.
  assert.equal(tzForState('AZ'), 'America/Phoenix');
  const t = AT('2026-08-06T23:30:00Z');          // 4:30pm PT/AZ, 5:30pm MT
  assert.equal(isWithinSendWindowFor('AZ', t), true);   // still open
  assert.equal(isWithinSendWindowFor('CO', t), false);  // Denver has closed
});

test('state names resolve as well as codes, and the unknown falls back east', () => {
  assert.equal(tzForState('Michigan'), 'America/New_York');
  assert.equal(tzForState('michigan'), 'America/New_York');
  assert.equal(tzForState('MI'), 'America/New_York');
  assert.equal(tzForState(''), 'America/New_York');
  assert.equal(tzForState(null), 'America/New_York');
  assert.equal(tzForState('Narnia'), 'America/New_York');
});

// ── Nights and weekends still stop everything ───────────────────────────────

test('nobody is mailed in the middle of the night', () => {
  const t = AT('2026-08-06T08:00:00Z');          // 4am ET, 1am PT
  assert.equal(isWithinSendWindow(t), false);
  assert.equal(openZones(t).length, 0);
  for (const s of ['MI', 'CO', 'CA', 'NY', 'TX']) {
    assert.equal(isWithinSendWindowFor(s, t), false, s);
  }
});

test('weekends are off in every zone', () => {
  const sat = AT('2026-08-08T17:00:00Z');        // Saturday, 1pm ET
  assert.equal(isWithinSendWindow(sat), false);
  assert.equal(isWithinSendWindowFor('CA', sat), false);
  assert.equal(isWithinSendWindowFor('NY', sat), false);
});

// ── Parking a lead until its own morning ────────────────────────────────────

test('a lead outside its hours is parked until its next local open', () => {
  const t = AT('2026-08-06T13:30:00Z');          // 9:30am ET — too early in CA
  const next = nextWindowOpen('CA', t);
  assert.equal(isWithinSendWindowFor('CA', next), true);
  assert.ok(next > t);
  // Same day, not tomorrow: California opens a few hours later.
  assert.ok(next - t < 12 * 3600000);
});

test('a Friday-evening lead is parked to Monday, not Saturday', () => {
  const fri = AT('2026-08-07T23:30:00Z');        // Friday 7:30pm ET
  const next = nextWindowOpen('NY', fri);
  assert.equal(isWithinSendWindowFor('NY', next), true);
  assert.equal(next.getUTCDay(), 1);             // Monday
});

// ── Pacing spans the real sending day ───────────────────────────────────────

test('pacing measures to the LAST open zone, not to Eastern 5pm', () => {
  const t = AT('2026-08-06T22:00:00Z');          // 6pm ET, 3pm PT — Eastern is done
  // The old math returned 0 here and the engine stopped pacing for the day,
  // even though Pacific had two full hours of business left.
  assert.equal(windowMinutesLeft(t), 120);
  assert.equal(windowMinutesLeft(AT('2026-08-06T08:00:00Z')), 0);   // real night
});

test('the Studio gets short labels, not IANA identifiers', () => {
  assert.equal(zoneLabel('America/New_York'), 'ET');
  assert.equal(zoneLabel('America/Los_Angeles'), 'PT');
  assert.equal(zoneLabel('America/Phoenix'), 'AZ');
});

test('Hawaii and Alaska get their own morning but do not stretch the day', () => {
  // 10:45am in Honolulu, 6:45pm Eastern, 3:45pm Pacific. Pacing must follow the
  // mainland (Pacific has ~75 min left), not Honolulu's six remaining hours —
  // otherwise the daily cap spreads across a day that isn't really happening and
  // the mainland gets starved of sends all afternoon.
  const t = AT('2026-08-06T20:45:00Z');
  assert.ok(windowMinutesLeft(t) < 300);
  // …while a Hawaii lead is still perfectly mailable right now.
  assert.equal(isWithinSendWindowFor('HI', t), true);
});
