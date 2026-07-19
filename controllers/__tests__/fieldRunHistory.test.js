// controllers/__tests__/fieldRunHistory.test.js
//
// Pure tests for the mission log's per-day scoreboard (controllers/
// fieldRun.summarizeRun) and the roster autopilot's pick logic.
//
//   node --test controllers/__tests__/fieldRunHistory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeRun } = require('../fieldRun');
const { pickRosterState, rosterPriorityOrder } = require('../../services/rosterAutopilot');

const RUN = {
  _id: 'r1',
  label: '2026-07-18',
  createdAt: new Date('2026-07-18T12:00:00Z'),
  endedAt: new Date('2026-07-18T23:00:00Z'),
  startLat: 39.85, startLng: -75.0,
  stops: [
    { order: 1, lat: 39.9, lng: -75.1, status: 'visited', outcome: 'pitched', contactEmail: 'a@x.com', catalogQueued: true, catalogSentAt: new Date() },
    { order: 0, lat: 39.87, lng: -75.05, status: 'visited', outcome: 'no_buyer' },
    { order: 2, lat: 39.95, lng: -75.16, status: 'pending' },
    { order: 3, lat: 40.0, lng: -75.2, status: 'visited', outcome: 'pitched', catalogQueued: true },
  ],
};

test('summarizeRun counts the day correctly', () => {
  const s = summarizeRun(RUN);
  assert.equal(s.stops, 4);
  assert.equal(s.visited, 3);
  assert.equal(s.pitched, 2);
  assert.equal(s.contacts, 1);
  assert.equal(s.catalogsQueued, 2);
  assert.equal(s.catalogsSent, 1);
  assert.equal(s.label, '2026-07-18');
  assert.ok(s.miles > 5 && s.miles < 40, `miles sane, got ${s.miles}`);
});

test('summarizeRun tolerates an empty / start-less run', () => {
  const s = summarizeRun({ _id: 'r2', stops: [] });
  assert.equal(s.stops, 0);
  assert.equal(s.miles, 0);
  const s2 = summarizeRun({ _id: 'r3', stops: [{ order: 0, lat: 40, lng: -75, status: 'pending' }] });
  assert.equal(s2.stops, 1);
});

// ── Roster autopilot picks ───────────────────────────────────────────────────

test('rosterPriorityOrder starts at home ground and includes the med states', () => {
  const order = rosterPriorityOrder();
  assert.equal(order[0], 'NJ');
  assert.ok(order.indexOf('PA') >= 0 && order.indexOf('PA') < 5, 'PA near the front');
  assert.ok(order.includes('OK') && order.includes('FL'), 'med states present');
});

test('pickRosterState: never-loaded state wins over everything', () => {
  const pick = pickRosterState({
    order: ['NJ', 'NY', 'PA'],
    counts: { NJ: 250, NY: 400 },        // PA has no roster rows
    freshest: { NJ: new Date(), NY: new Date() },
  });
  assert.deepEqual(pick, { state: 'PA', reason: 'empty' });
});

test('pickRosterState: with everything loaded, the stalest past the window wins', () => {
  const now = Date.now();
  const pick = pickRosterState({
    order: ['NJ', 'NY', 'PA'],
    counts: { NJ: 250, NY: 400, PA: 190 },
    freshest: {
      NJ: new Date(now - 50 * 86400000),  // stale, older
      NY: new Date(now - 46 * 86400000),  // stale, newer
      PA: new Date(now - 1 * 86400000),   // fresh
    },
    now,
  });
  assert.deepEqual(pick, { state: 'NJ', reason: 'stale' });
});

test('pickRosterState: all fresh → nothing to do', () => {
  const now = Date.now();
  assert.equal(pickRosterState({
    order: ['NJ'],
    counts: { NJ: 250 },
    freshest: { NJ: new Date(now - 86400000) },
    now,
  }), null);
});
