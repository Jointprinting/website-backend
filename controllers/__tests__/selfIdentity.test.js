// controllers/__tests__/selfIdentity.test.js
//
// Pins the SELF-identity recognition that stops the receipt scanner from ever
// stamping Joint Printing itself as the counter-party on a transaction (the
// reported bug: an income invoice booked with party = "Joint Printing LLC").
// Pure-logic, no DB / no API:
//
//   node --test controllers/__tests__/selfIdentity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSelf, firstNonSelf } = require('../../services/selfIdentity');

// ── isSelf: every spelling of US is recognized ───────────────────────────────
test('isSelf: our own trading names (case / suffix / punctuation insensitive)', () => {
  assert.equal(isSelf('Joint Printing'), true);
  assert.equal(isSelf('Joint Printing LLC'), true);
  assert.equal(isSelf('joint printing'), true);
  assert.equal(isSelf('  JOINT PRINTING  '), true);
  assert.equal(isSelf('JOINT PRINTING, INC.'), true);   // a different suffix still = us
  assert.equal(isSelf('JointPrinting'), true);
});

test('isSelf: our domain / an email at our domain / a URL', () => {
  assert.equal(isSelf('jointprinting.com'), true);
  assert.equal(isSelf('nate@jointprinting.com'), true);
  assert.equal(isSelf('billing@jointprinting.com'), true);
  assert.equal(isSelf('https://www.jointprinting.com/invoice'), true);
});

test('isSelf: blank / nullish → false (an unknown party is never mistaken for us)', () => {
  assert.equal(isSelf(''), false);
  assert.equal(isSelf('   '), false);
  assert.equal(isSelf(null), false);
  assert.equal(isSelf(undefined), false);
});

test('isSelf: real clients / vendors / other domains → false (no false positives)', () => {
  assert.equal(isSelf('NJ Dental 1'), false);
  assert.equal(isSelf('Alex Gelman'), false);
  assert.equal(isSelf('SanMar'), false);
  assert.equal(isSelf('Heritage Screen Printing'), false);
  // A name that merely SHARES a word must not collapse to us (suffix-strip is
  // end-anchored; the key is the whole remaining name).
  assert.equal(isSelf('Joint Venture Printing'), false);
  assert.equal(isSelf('alex@gmail.com'), false);    // email at a foreign domain
});

// ── firstNonSelf: picks the real other party off a doc that names us + them ──
test('firstNonSelf: returns the first non-self, non-blank candidate', () => {
  // A JP invoice names both the seller (us) and the bill-to (the client).
  assert.equal(firstNonSelf('Joint Printing LLC', 'NJ Dental 1'), 'NJ Dental 1');
  assert.equal(firstNonSelf('NJ Dental 1', 'Joint Printing'), 'NJ Dental 1');
  // Skips blanks and self in order.
  assert.equal(firstNonSelf('', '  ', 'Joint Printing', 'Heritage'), 'Heritage');
});

test('firstNonSelf: all candidates self/blank → "" (caller leaves party blank)', () => {
  assert.equal(firstNonSelf('Joint Printing', 'jointprinting.com', ''), '');
  assert.equal(firstNonSelf('', '   ', null, undefined), '');
});
