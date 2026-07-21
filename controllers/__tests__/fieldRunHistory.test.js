// controllers/__tests__/fieldRunHistory.test.js
//
// Pure tests for the mission log's per-day scoreboard (controllers/
// fieldRun.summarizeRun) and the roster autopilot's pick logic.
//
//   node --test controllers/__tests__/fieldRunHistory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeRun } = require('../fieldRun');
const { pickRosterStates, rosterPriorityOrder } = require('../../services/rosterAutopilot');
const { stateForViewportCenter } = require('../dispensary');

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

test('rosterPriorityOrder starts at home ground, includes med states, excludes roster-less DE', () => {
  const order = rosterPriorityOrder();
  assert.equal(order[0], 'NJ');
  assert.ok(order.indexOf('PA') >= 0 && order.indexOf('PA') < 5, 'PA near the front');
  assert.ok(order.includes('OK') && order.includes('FL'), 'med states present');
  assert.ok(order.includes('OH'), 'OH is loadable');
  // The DE wedge: no machine-readable roster (kind google) — picking it as
  // "first empty state" and failing blocked every state behind it. Never again.
  assert.ok(!order.includes('DE'), 'DE must not be in the loadable order');
});

test('pickRosterStates: every never-loaded state queues first, in priority order', () => {
  const picks = pickRosterStates({
    order: ['NJ', 'NY', 'OH', 'PA'],
    counts: { NJ: 250, NY: 400 },        // OH + PA have no roster rows
    freshest: { NJ: new Date(), NY: new Date() },
  });
  assert.deepEqual(picks.slice(0, 2), [
    { state: 'OH', reason: 'empty' },
    { state: 'PA', reason: 'empty' },
  ]);
});

test('pickRosterStates: a skip set (cooldown / in-flight) is passed over, not blocking', () => {
  const picks = pickRosterStates({
    order: ['NJ', 'OH', 'PA'],
    counts: { NJ: 250 },
    freshest: { NJ: new Date() },
    skip: new Set(['OH']),               // OH failed recently → next candidate proceeds
  });
  assert.deepEqual(picks[0], { state: 'PA', reason: 'empty' });
});

test('pickRosterStates: with everything loaded, stalest-first past the window', () => {
  const now = Date.now();
  const picks = pickRosterStates({
    order: ['NJ', 'NY', 'PA'],
    counts: { NJ: 250, NY: 400, PA: 190 },
    freshest: {
      NJ: new Date(now - 50 * 86400000),  // stale, older
      NY: new Date(now - 46 * 86400000),  // stale, newer
      PA: new Date(now - 1 * 86400000),   // fresh
    },
    now,
  });
  assert.deepEqual(picks, [
    { state: 'NJ', reason: 'stale' },
    { state: 'NY', reason: 'stale' },
  ]);
});

test('pickRosterStates: all fresh → nothing to do', () => {
  const now = Date.now();
  assert.deepEqual(pickRosterStates({
    order: ['NJ'],
    counts: { NJ: 250 },
    freshest: { NJ: new Date(now - 86400000) },
    now,
  }), []);
});

// ── Viewport → state (the on-demand seeding hook) ────────────────────────────

test('stateForViewportCenter: the reported Cleveland viewport resolves to OH', () => {
  // Cleveland → Canton, the exact "0 IN VIEW" screenshot shape.
  assert.equal(stateForViewportCenter({ minLat: 40.5, maxLat: 41.7, minLng: -82.3, maxLng: -80.9 }), 'OH');
});

test('stateForViewportCenter: overlapping region boxes pick the smallest container', () => {
  // Trenton NJ sits inside both the NJ and (bleed-over) NY/PA boxes — NJ wins.
  assert.equal(stateForViewportCenter({ minLat: 40.1, maxLat: 40.3, minLng: -74.9, maxLng: -74.6 }), 'NJ');
});

test('stateForViewportCenter: open ocean resolves to nothing', () => {
  assert.equal(stateForViewportCenter({ minLat: 30, maxLat: 31, minLng: -60, maxLng: -59 }), '');
});
