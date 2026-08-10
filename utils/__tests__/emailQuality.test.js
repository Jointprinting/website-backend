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
  isNeverSend, isRoleInbox, looksLikePerson, looksLikeHumanName, nameShaped, emailTier, scoreEmail, bestEmail, localHead,
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

test('only a MULTI-PART local-part is evidence of a person', () => {
  // jane.doe / j.doe / jane_doe / mary-beth — nobody names a functional mailbox
  // that way, so the shape itself is the evidence.
  for (const ok of ['jane.doe', 'j.doe', 'jane_doe', 'mary-beth', 'sam.rivera']) {
    assert.equal(looksLikePerson(ok), true, `${ok} should read as a person`);
  }
  // A SINGLE word is not. This is a deliberate change: 'jane' and 'feedback' are
  // the same shape, and treating unrecognized singles as people put them in the
  // TOP tier — above a published info@ — which is how the engine came to prefer
  // feedback@ and cbd@ and then hard-bounce on both. No blacklist ever finishes
  // that job, so the inference goes rather than growing forever.
  for (const no of ['jane', 'jdoe', 'feedback', 'cbd', 'thc', 'hemp', 'wellness',
    'info', 'careers', 'shop', 'store', 'deals', 'specials', 'budtenders',
    'order12345', '', 'a', '2024sale', 'x'.repeat(40)]) {
    assert.equal(looksLikePerson(no), false, `${no} should NOT read as a person`);
  }
});

test('a contact NAME we hold is the evidence the address cannot give', () => {
  // The signal that survives: we can't tell jane@ from feedback@, but a record
  // saying the contact is Jane Rivera settles it.
  for (const ok of ['Jane Doe', 'Rebecca Pool', 'Mary-Beth O’Brien', 'Sam']) {
    assert.equal(looksLikeHumanName(ok), true, ok);
  }
  // Departments are not people, however they're stored.
  for (const no of ['Front Desk', 'Sales Team', 'info', 'Purchasing', '', '   ', '12345']) {
    assert.equal(looksLikeHumanName(no), false, JSON.stringify(no));
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

// ── The addresses that actually hard-bounced ─────────────────────────────────
// Three "Address not found" NDRs arrived in fifteen minutes. Two of the three
// addresses had been CHOSEN over a better one on the same domain, because a
// single unrecognized word scored as a person (40) and beat a published info@
// (25). "feedback" and "cbd" are simply words nobody had blacklisted yet — the
// list was never going to catch up, so the inference had to go.

test('the real bounce cases rank below a published role inbox', () => {
  for (const bad of ['feedback@krystaleaves.com', 'cbd@cbdandoils.com']) {
    assert.equal(emailTier(bad), 'unknown', bad);
    assert.ok(scoreEmail(bad) < scoreEmail('info@krystaleaves.com'), bad);
  }
  assert.equal(bestEmail(['feedback@krystaleaves.com', 'info@krystaleaves.com'], 'krystaleaves.com'),
    'info@krystaleaves.com');
  assert.equal(bestEmail(['cbd@cbdandoils.com', 'contact@cbdandoils.com'], 'cbdandoils.com'),
    'contact@cbdandoils.com');
});

test('a genuinely named human still outranks the front door', () => {
  // The good half of the old behavior has to survive: this is not a retreat to
  // "always mail info@".
  assert.ok(scoreEmail('sam.rivera@greenleaf.com') > scoreEmail('info@greenleaf.com'));
  assert.equal(bestEmail(['info@greenleaf.com', 'sam.rivera@greenleaf.com'], 'greenleaf.com'),
    'sam.rivera@greenleaf.com');
});

test('nameShaped separates a plausible name from an alias blob', () => {
  for (const ok of ['jane', 'jane.doe', 'j.doe', 'mary-beth']) assert.equal(nameShaped(ok), true, ok);
  for (const no of ['xq7zplt', 'order12345', 'a1b2c3d4', 'info', 'careers']) {
    assert.equal(nameShaped(no), false, no);
  }
});

// ── Cannabis-adjacent businesses that are not dispensaries ───────────────────
// From the owner's own bounce log: merry.jane@hightimes.com went out and
// bounced. High Times is a magazine. These rank for every cannabis search term
// so scraping drags them in constantly, and none of them can buy dispensary
// merch — the pitch was never going to land even if the address had worked.

test('a magazine or a platform can never be a merch buyer', () => {
  for (const bad of [
    'merry.jane@hightimes.com',      // the real bounce
    'editor@leafly.com',
    'info@weedmaps.com',
    'sales@dutchie.com',             // they sell TO dispensaries, not the reverse
    'hello@iheartjane.com',
    'contact@sub.hightimes.com',     // suffix match honors the dot boundary
  ]) {
    assert.equal(isNeverSend(bad), true, bad);
    assert.equal(emailTier(bad), 'never', bad);
    assert.ok(scoreEmail(bad) < 0, bad);
  }
});

test('a real dispensary on a similar-looking domain is untouched', () => {
  for (const ok of [
    'info@greenleafdispensary.com',
    'wholesale@thehighlifedispensary.com',   // contains "high", not hightimes.com
    'sam.rivera@notweedmaps.com',            // not a suffix match
  ]) {
    assert.equal(isNeverSend(ok), false, ok);
  }
});
