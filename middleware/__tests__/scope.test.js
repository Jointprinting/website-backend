// middleware/__tests__/scope.test.js
//
// Ownership scoping helpers (multi-user: owner + agents). Pure — no DB, no Express.
//   node --test middleware/__tests__/scope.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { visibleFilter, stampFor, canAccessDoc, isAgent } = require('../scope');

const owner = (q = {}) => ({ user: { role: 'owner', userId: 'owner1' }, query: q });
const agent = (q = {}) => ({ user: { role: 'agent', userId: 'agentA' }, query: q });
const legacy = (q = {}) => ({ user: { role: 'owner', userId: null }, query: q }); // pre-uid token

// ── visibleFilter ─────────────────────────────────────────────────────────────
test('agent is hard-locked to their own id — query overrides are ignored', () => {
  assert.deepEqual(visibleFilter(agent()), { agentId: 'agentA' });
  // An agent trying to widen their view via ?agentId=all or another id gets nowhere.
  assert.deepEqual(visibleFilter(agent({ agentId: 'all' })), { agentId: 'agentA' });
  assert.deepEqual(visibleFilter(agent({ agentId: 'owner1' })), { agentId: 'agentA' });
});

test('owner defaults to own + legacy records (incl. pre-agents docs with no agentId)', () => {
  // `null` in the $in also matches documents written BEFORE the agentId field
  // existed (missing field), so legacy records are never hidden from the owner.
  assert.deepEqual(visibleFilter(owner()), { agentId: { $in: ['', 'owner1', null] } });
});

test('owner can view one agent (?agentId) or everything (?agentId=all)', () => {
  assert.deepEqual(visibleFilter(owner({ agentId: 'agentA' })), { agentId: 'agentA' });
  assert.deepEqual(visibleFilter(owner({ agentId: 'all' })), {});
});

test('a legacy owner token (no uid) still sees all legacy ("") records', () => {
  // uid null → ['', '', null] → agentId in ['', null] — every current + pre-agents record.
  assert.deepEqual(visibleFilter(legacy()), { agentId: { $in: ['', '', null] } });
});

// ── stampFor ──────────────────────────────────────────────────────────────────
test('stampFor: owner-created records stay "", an agent stamps their id', () => {
  assert.equal(stampFor(owner()), '');
  assert.equal(stampFor(agent()), 'agentA');
});

// ── canAccessDoc ──────────────────────────────────────────────────────────────
test('canAccessDoc: owner sees anything; agent only their own', () => {
  assert.equal(canAccessDoc(owner(), { agentId: 'agentA' }), true);   // owner → any
  assert.equal(canAccessDoc(owner(), { agentId: '' }), true);
  assert.equal(canAccessDoc(agent(), { agentId: 'agentA' }), true);   // agent → own
  assert.equal(canAccessDoc(agent(), { agentId: '' }), false);        // agent ✗ owner's
  assert.equal(canAccessDoc(agent(), { agentId: 'agentB' }), false);  // agent ✗ another agent's
  assert.equal(canAccessDoc(agent(), null), false);
});

test('isAgent: true only for the agent role', () => {
  assert.equal(isAgent(agent()), true);
  assert.equal(isAgent(owner()), false);
  assert.equal(isAgent({}), false);
});
