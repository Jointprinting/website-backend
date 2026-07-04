// controllers/__tests__/admin.test.js
//
// Pure bits of the agent-admin controller (no DB): the client shape never leaks
// the password hash, and the goal-month key is well-formed.
//   node --test controllers/__tests__/admin.test.js

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-abc123';

const test = require('node:test');
const assert = require('node:assert/strict');

const { publicAgent, currentMonth, computeAgentStats } = require('../admin');
const Order = require('../../models/Order');
const Client = require('../../models/Client');

test('publicAgent NEVER exposes the password hash (or _id as raw)', () => {
  const shaped = publicAgent({
    _id: 'objid1', username: 'mike', passwordHash: 'bcrypt$SECRET',
    displayName: 'Mike', active: true, monthlyGoal: 5000, goalMonth: '2026-07',
    loginCount: 3, lastLoginAt: new Date(), failedLoginAttempts: 2, lockedUntil: new Date(),
  });
  const json = JSON.stringify(shaped);
  assert.doesNotMatch(json, /SECRET|passwordHash|bcrypt/);
  assert.doesNotMatch(json, /failedLoginAttempts|lockedUntil/); // internal security fields stay server-side
  assert.equal(shaped.id, 'objid1');
  assert.equal(shaped.username, 'mike');
  assert.equal(shaped.monthlyGoal, 5000);
});

test('publicAgent: active defaults true unless explicitly false', () => {
  assert.equal(publicAgent({ _id: 'a', username: 'x' }).active, true);
  assert.equal(publicAgent({ _id: 'a', username: 'x', active: false }).active, false);
});

test('currentMonth is a zero-padded YYYY-MM in UTC', () => {
  assert.equal(currentMonth(new Date(Date.UTC(2026, 0, 9))), '2026-01');
  assert.equal(currentMonth(new Date(Date.UTC(2026, 11, 31))), '2026-12');
});

test('computeAgentStats measures the CURRENT month (never a stale goalMonth) and labels pace', async (t) => {
  // Mock the two model reads. countDocuments → thenable; find→select→lean→Promise.
  t.mock.method(Client, 'countDocuments', () => Promise.resolve(4));
  t.mock.method(Order, 'find', () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }));

  // A goalMonth from years ago must NOT freeze the window — the fix for the stale
  // "permanent behind pace" bug.
  const stats = await computeAgentStats({ _id: 'x', monthlyGoal: 0, goalMonth: '2020-01' });
  assert.equal(stats.month, currentMonth(), 'window is the current month, not the stored goalMonth');
  assert.equal(stats.paceLabel, 'none', 'no goal → none');
  assert.equal(stats.leads, 4);
  assert.equal(stats.ordersThisMonth, 0);
});
