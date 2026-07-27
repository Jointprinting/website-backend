// utils/__tests__/emailQuality.test.js
//
// The bounce engine. Both address rankers — the harvester's pickBestEmail and
// the sender's pickEmail — independently scored ANY local-part outside a short
// role list as "a named person". That put careers@, privacy@, webmaster@ and
// postmaster@ AHEAD of info@, so the lead finder preferentially harvested, and
// the engine preferentially mailed, the one address on a shop's page least
// likely to exist. Every one of those is a hard bounce, and the old bounce
// handler answered a bounce by blacklisting the whole dispensary.
//
// These pin the shared verdict that replaced both rankers.
//
//   node --test utils/__tests__/emailQuality.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isNeverSend, isRoleInbox, looksLikePerson, emailTier, scoreEmail, bestEmail, localHead,
} = require('../emailQuality');

// ── The exact regression ─────────────────────────────────────────────────────

test('info@ beats every never-send alias the old ranker preferred', () => {
  const shop = 'greenleaf.com';
  for (const junk of [
    'careers@greenleaf.com', 'privacy@greenleaf.com', 'webmaster@greenleaf.com',
    'postmaster@greenleaf.com', 'legal@greenleaf.com', 'press@greenleaf.com',
    'billing@greenleaf.com', 'hr@greenleaf.com', 'abuse@greenleaf.com',
    'noreply@greenleaf.com', 'jobs@greenleaf.com', 'dmca@greenleaf.com',
  ]) {
    assert.equal(
      bestEmail([junk, 'info@greenleaf.com'], { siteHost: shop }),
      'info@greenleaf.com',
      `${junk} must never outrank info@`
    );
    assert.equal(isNeverSend(junk), true, `${junk} must be never-send`);
  }
});

test('a never-send address is never returned, even as the only candidate', () => {
  assert.equal(bestEmail(['careers@greenleaf.com'], { siteHost: 'greenleaf.com' }), '');
  assert.equal(bestEmail(['noreply@greenleaf.com']), '');
  assert.equal(bestEmail([]), '');
  assert.equal(bestEmail(null), '');
});

// ── Tiering ──────────────────────────────────────────────────────────────────

test('a named person outranks a role inbox, which outranks an unknown alias', () => {
  const host = 'greenleaf.com';
  assert.equal(emailTier('jane.doe@greenleaf.com'), 'person');
  assert.equal(emailTier('info@greenleaf.com'), 'role');
  assert.equal(emailTier('xq7zplt@greenleaf.com'), 'unknown');
  assert.equal(emailTier('postmaster@greenleaf.com'), 'never');
  assert.equal(bestEmail(['info@greenleaf.com', 'jane.doe@greenleaf.com'], { siteHost: host }), 'jane.doe@greenleaf.com');
  assert.ok(scoreEmail('info@greenleaf.com', { siteHost: host }) > scoreEmail('xq7zplt@greenleaf.com', { siteHost: host }),
    'an unrecognized alias must rank BELOW a known-good role inbox — that inversion is what caused the bounces');
});

test('the shop’s own domain beats an off-domain address of the same tier', () => {
  assert.equal(
    bestEmail(['info@somewebagency.com', 'info@greenleaf.com'], { siteHost: 'greenleaf.com' }),
    'info@greenleaf.com'
  );
  // A named person off-domain still loses to a role inbox ON domain.
  assert.equal(
    bestEmail(['jane.doe@gmail.com', 'info@greenleaf.com'], { siteHost: 'greenleaf.com' }),
    'info@greenleaf.com'
  );
});

test('buying-adjacent role inboxes rank above the help desk', () => {
  const host = 'greenleaf.com';
  assert.equal(bestEmail(['support@greenleaf.com', 'wholesale@greenleaf.com'], { siteHost: host }), 'wholesale@greenleaf.com');
  assert.equal(bestEmail(['service@greenleaf.com', 'info@greenleaf.com'], { siteHost: host }), 'info@greenleaf.com');
});

// ── Separator / tag handling ─────────────────────────────────────────────────

test('separators and plus-tags classify by their head', () => {
  assert.equal(localHead('sales.team'), 'sales');
  assert.equal(localHead('info+nj'), 'info');
  assert.equal(localHead('careers-us'), 'careers');
  assert.equal(localHead('noreply01'), 'noreply');
  assert.equal(isNeverSend('careers-us@x.com'), true);
  assert.equal(isRoleInbox('info+nj@x.com'), true);
  assert.equal(isNeverSend('no-reply@x.com'), true);
});

// ── looksLikePerson is deliberately conservative ─────────────────────────────

test('looksLikePerson accepts real name shapes and rejects function words', () => {
  for (const ok of ['jane', 'jane.doe', 'j.doe', 'jdoe', 'jane_doe', 'mary-beth']) {
    assert.equal(looksLikePerson(ok), true, `${ok} should read as a person`);
  }
  for (const no of ['info', 'careers', 'shop', 'store', 'deals', 'specials', 'budtenders',
    'order12345', '', 'a', '2024sale', 'x'.repeat(40)]) {
    assert.equal(looksLikePerson(no), false, `${no} should NOT read as a person`);
  }
});

// ── Degenerate input never throws ────────────────────────────────────────────

test('junk input degrades safely instead of throwing', () => {
  for (const junk of [null, undefined, '', '   ', 'not-an-email', '@x.com', 'a@', 42, {}, []]) {
    assert.equal(isNeverSend(junk), true, 'unparseable is never sendable');
    assert.doesNotThrow(() => emailTier(junk));
    assert.doesNotThrow(() => scoreEmail(junk));
    assert.ok(scoreEmail(junk) < 0);
  }
  assert.doesNotThrow(() => bestEmail(['x', null, undefined, 'info@a.com']));
  assert.equal(bestEmail(['x', null, 'info@a.com']), 'info@a.com');
});

test('case and whitespace do not change the verdict', () => {
  assert.equal(isNeverSend('  CAREERS@GreenLeaf.COM '), true);
  assert.equal(bestEmail(['  INFO@GreenLeaf.com  '], { siteHost: 'GreenLeaf.com' }), 'info@greenleaf.com');
});
