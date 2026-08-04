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

// ── ownershipStamp: agentId and originAgentId start life identical ───────────
//
// They only diverge when a book is reassigned — reassignment moves agentId and
// never touches originAgentId, which is what lets the owner hand a departed
// agent's whole book to someone else without rewriting the commission history
// his statements were computed from.

const { ownershipStamp } = require('../scope');

test('ownershipStamp stamps BOTH fields for an agent', () => {
  const s = ownershipStamp({ user: { role: 'agent', userId: 'agent-1' } });
  assert.deepEqual(s, { agentId: 'agent-1', originAgentId: 'agent-1' });
});

test('ownershipStamp leaves owner-created records on the legacy empty convention', () => {
  const s = ownershipStamp({ user: { role: 'owner', userId: 'owner-9' } });
  assert.deepEqual(s, { agentId: '', originAgentId: '' });
});

test('ownershipStamp is safe on a malformed request', () => {
  assert.deepEqual(ownershipStamp(), { agentId: '', originAgentId: '' });
  assert.deepEqual(ownershipStamp({}), { agentId: '', originAgentId: '' });
});

test('a reassignment moves agentId but NEVER originAgentId', () => {
  // Models the updateMany in reassignAgentBook: only agentId is in the $set.
  const book = [
    { companyKey: 'happyleaf', agentId: 'agent-1', originAgentId: 'agent-1' },
    { companyKey: 'bleuleaf',  agentId: 'agent-1', originAgentId: '' },        // a house lead he was handed
  ];
  const reassigned = book.map((r) => ({ ...r, agentId: '' }));  // to the owner

  assert.equal(reassigned[0].agentId, '', 'the owner works it now');
  assert.equal(reassigned[0].originAgentId, 'agent-1', 'but agent-1 still sourced it');
  assert.equal(reassigned[1].originAgentId, '', 'a house lead stays house');

  // The agent is still visible as the source, so their earned statements stand.
  const stillCredited = reassigned.filter((r) => r.originAgentId === 'agent-1');
  assert.equal(stillCredited.length, 1);
});

test('visibleFilter after a reassignment shows the book to its NEW owner', () => {
  // The owner's default filter matches '' (their own) — so a book reassigned to
  // them appears in their CRM immediately, without a second migration step.
  const f = visibleFilter({ user: { role: 'owner', userId: 'owner-9' } });
  assert.ok(f.agentId.$in.includes(''), 'reassigned-to-owner rows are visible');
});
