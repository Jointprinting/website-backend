// utils/__tests__/replyPath.test.js
//
// Pins the reply-path contract — the check that makes a silent campaign
// falsifiable. The headline case is the live one: outreach sends from (and
// replies to) the cold-sending mailbox while the reply sync is signed in to a
// DIFFERENT mailbox, so every reply is invisible and the reply counter is
// measuring the wrong inbox. That must read 'action', never 'ok'.
//
// Also pins the degenerate cases: anything unknown/blank degrades to 'ok' with
// monitored:false (a missing env var must not manufacture a scary alert), and
// nothing ever throws.
//
//   node --test utils/__tests__/replyPath.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { replyPathStatus, normalizeAddress } = require('../replyPath');

// The two mailboxes in play, named once.
const SENDING = 'nate@jointprintingshop.com'; // cold-sending identity
const READING = 'nate@jointprinting.com';     // where the owner + Studio read

// ── The live black hole ──────────────────────────────────────────────────────
test('sending mailbox ≠ triage mailbox → action, not monitored, hint names both', () => {
  const r = replyPathStatus({
    from: SENDING, replyTo: SENDING,
    triageAddress: READING, triageConfigured: true,
    ownerAddress: READING,
  });
  assert.equal(r.level, 'action');
  assert.equal(r.monitored, false);
  assert.equal(r.destination, SENDING);
  assert.equal(r.triageAddress, READING);
  // The fix has to be readable without opening the code.
  assert.ok(r.hint.includes(SENDING) && r.hint.includes(READING), r.hint);
  assert.ok(/OUTREACH_REPLY_TO|forward/i.test(r.hint), r.hint);
  assert.ok(r.label);
});

test('no Reply-To at all → replies fall back to the From address (same black hole)', () => {
  const r = replyPathStatus({
    from: SENDING, replyTo: '',
    triageAddress: READING, triageConfigured: true, ownerAddress: READING,
  });
  assert.equal(r.destination, SENDING);
  assert.equal(r.level, 'action');
  assert.equal(r.monitored, false);
});

// ── The fixed shape ──────────────────────────────────────────────────────────
test('Reply-To pointed at the triage mailbox → ok + monitored', () => {
  const r = replyPathStatus({
    from: SENDING, replyTo: READING,
    triageAddress: READING, triageConfigured: true, ownerAddress: READING,
  });
  assert.equal(r.level, 'ok');
  assert.equal(r.monitored, true);
  assert.equal(r.destination, READING);
});

test('monitored but not the owner’s own inbox → warn (Studio sees it, his mail doesn’t)', () => {
  const r = replyPathStatus({
    from: SENDING, replyTo: 'replies@jointprintingshop.com',
    triageAddress: 'replies@jointprintingshop.com', triageConfigured: true,
    ownerAddress: READING,
  });
  assert.equal(r.level, 'warn');
  assert.equal(r.monitored, true);
  assert.ok(r.hint.includes('replies@jointprintingshop.com') && r.hint.includes(READING), r.hint);
});

test('monitored and it IS the owner’s inbox → ok', () => {
  const r = replyPathStatus({
    from: READING, replyTo: '', triageAddress: READING,
    triageConfigured: true, ownerAddress: READING,
  });
  assert.equal(r.level, 'ok');
  assert.equal(r.monitored, true);
});

test('unknown owner address never invents a warn', () => {
  const r = replyPathStatus({
    from: SENDING, replyTo: READING, triageAddress: READING,
    triageConfigured: true, ownerAddress: '',
  });
  assert.equal(r.level, 'ok');
  assert.equal(r.monitored, true);
});

// ── Triage off / unknown ─────────────────────────────────────────────────────
test('reply sync switched off with a real sending address → action', () => {
  const r = replyPathStatus({ from: SENDING, replyTo: '', triageAddress: '', triageConfigured: false });
  assert.equal(r.level, 'action');
  assert.equal(r.monitored, false);
  assert.equal(r.destination, SENDING);
  assert.ok(r.hint.includes(SENDING), r.hint);
});

test('sync on but its mailbox is unknown → ok (degrade, never guess an address)', () => {
  const r = replyPathStatus({ from: SENDING, replyTo: '', triageAddress: '', triageConfigured: true });
  assert.equal(r.level, 'ok');
  assert.equal(r.monitored, false);
  assert.equal(r.triageAddress, '');
  assert.ok(!r.hint.includes('undefined'), r.hint);
});

// ── Degenerate inputs: degrade to ok, never throw ────────────────────────────
test('no sending address configured → ok, nothing to judge', () => {
  const r = replyPathStatus({ from: '', replyTo: '', triageAddress: READING, triageConfigured: true });
  assert.equal(r.level, 'ok');
  assert.equal(r.monitored, false);
  assert.equal(r.destination, '');
});

test('missing / junk inputs never throw and never invent an address', () => {
  for (const args of [undefined, {}, null,
    { from: null, replyTo: undefined, triageAddress: 0, triageConfigured: 'yes', ownerAddress: {} },
    { from: 123, replyTo: [], triageAddress: NaN },
  ]) {
    const r = replyPathStatus(args || undefined);
    assert.equal(typeof r.level, 'string');
    assert.equal(['ok', 'warn', 'action'].includes(r.level), true);
    assert.equal(typeof r.hint, 'string');
    assert.equal(typeof r.label, 'string');
    assert.equal(r.monitored, false);
    assert.equal(r.destination, '');
    assert.equal(r.triageAddress, '');
  }
});

test('returns exactly the contracted keys', () => {
  const r = replyPathStatus({ from: SENDING, triageAddress: READING, triageConfigured: true });
  assert.deepEqual(Object.keys(r).sort(),
    ['destination', 'hint', 'label', 'level', 'monitored', 'triageAddress'].sort());
});

// ── Address shapes: case, whitespace, display names ──────────────────────────
test('case + whitespace differences are the SAME mailbox (no false alarm)', () => {
  const r = replyPathStatus({
    from: SENDING, replyTo: '  Nate@JointPrinting.COM ',
    triageAddress: 'NATE@jointprinting.com', triageConfigured: true, ownerAddress: ' nate@JOINTPRINTING.com',
  });
  assert.equal(r.level, 'ok');
  assert.equal(r.monitored, true);
  assert.equal(r.destination, READING);
});

test('display-name form is unwrapped to the bare address', () => {
  assert.equal(normalizeAddress('Nate <nate@x.com>'), 'nate@x.com');
  assert.equal(normalizeAddress('"Joint Printing" <Nate@X.com> '), 'nate@x.com');
  assert.equal(normalizeAddress('<nate@x.com>'), 'nate@x.com');
  assert.equal(normalizeAddress(' NATE@X.com '), 'nate@x.com');
  assert.equal(normalizeAddress(''), '');
  assert.equal(normalizeAddress(undefined), '');
  assert.equal(normalizeAddress(null), '');
  assert.equal(normalizeAddress(42), '');

  // …and a display-name From still compares equal to the bare triage address.
  const r = replyPathStatus({
    from: 'Joint Printing <Nate@JointPrinting.com>', replyTo: '',
    triageAddress: 'nate@jointprinting.com', triageConfigured: true, ownerAddress: READING,
  });
  assert.equal(r.destination, READING);
  assert.equal(r.level, 'ok');
  assert.equal(r.monitored, true);
});

test('display-name form on BOTH sides still catches a genuine mismatch', () => {
  const r = replyPathStatus({
    from: `Nate <${SENDING}>`, replyTo: '',
    triageAddress: `Nate <${READING}>`, triageConfigured: true, ownerAddress: READING,
  });
  assert.equal(r.level, 'action');
  assert.equal(r.monitored, false);
  assert.equal(r.destination, SENDING);
  assert.equal(r.triageAddress, READING);
});

// ── The engine side: effectiveReplyDestination + engineStatus back-compat ────
// engineStatus is DB-bound, so the two collections it reads unguarded are
// stubbed; everything else it touches is already .catch-guarded and degrades.
test('engineStatus() still returns its pre-existing fields and takes no argument', async () => {
  const mongoose = require('mongoose');
  mongoose.set('bufferCommands', false); // unstubbed reads reject fast instead of buffering

  const OutreachState = require('../../models/OutreachState');
  const OutreachEnrollment = require('../../models/OutreachEnrollment');
  const savedFindOne = OutreachState.findOne;
  const savedUpdate = OutreachState.findOneAndUpdate;
  const savedAgg = OutreachEnrollment.aggregate;
  const chain = (val) => ({ select: () => chain(val), lean: async () => val });
  OutreachState.findOne = () => chain(null);
  OutreachState.findOneAndUpdate = async () => null;
  OutreachEnrollment.aggregate = async () => [];

  try {
    const { engineStatus, effectiveReplyDestination } = require('../../services/outreachEngine');

    const s = await engineStatus(); // no argument — the original call shape
    for (const k of ['senderConfigured', 'smtpConfigured', 'from', 'senders', 'senderCount',
      'auth', 'authGate', 'deliverability', 'withinWindow', 'firstSendAt', 'rampWeek',
      'dailyCap', 'dailyCapMax', 'sentToday', 'remainingToday', 'publicLinksConfigured',
      'lastRunAt', 'lastResult']) {
      assert.ok(k in s, `engineStatus lost the ${k} field`);
    }
    // …and it now carries the reply path.
    assert.equal(typeof s.replyPath, 'object');
    assert.equal(['ok', 'warn', 'action'].includes(s.replyPath.level), true);
    assert.equal(s.replyPath.monitored, false); // no triage identity passed → degrade

    // Old positional signature still works.
    const byDate = await engineStatus(new Date());
    assert.equal(typeof byDate.dailyCap, 'number');

    // New options form: the triage identity is passed IN (no controllers import).
    const withTriage = await engineStatus({
      triageIdentity: { address: 'someone@else.com', checkedAt: null, configured: true },
    });
    assert.equal(withTriage.replyPath.triageAddress, 'someone@else.com');

    // effectiveReplyDestination never throws and exposes the whole identity set.
    const dest = effectiveReplyDestination();
    assert.equal(typeof dest.address, 'string');
    assert.ok(Array.isArray(dest.identities));
    assert.ok(Array.isArray(dest.destinations));
    assert.equal(typeof dest.agree, 'boolean');
  } finally {
    OutreachState.findOne = savedFindOne;
    OutreachState.findOneAndUpdate = savedUpdate;
    OutreachEnrollment.aggregate = savedAgg;
    mongoose.set('bufferCommands', true);
  }
});

test('effectiveReplyDestination mirrors the send path: replyTo wins, else From', async () => {
  const modPath = require.resolve('../../services/outreachEngine');
  const poolPath = require.resolve('../../services/senderPool');
  const saved = { from: process.env.OUTREACH_EMAIL_FROM, rt: process.env.OUTREACH_REPLY_TO, senders: process.env.OUTREACH_SENDERS };
  const reload = () => {
    delete require.cache[modPath];
    delete require.cache[poolPath];
    return require('../../services/outreachEngine');
  };
  try {
    // Legacy single identity, no OUTREACH_REPLY_TO → replies go back to From.
    delete process.env.OUTREACH_SENDERS;
    process.env.OUTREACH_EMAIL_FROM = `Nate <${SENDING}>`;
    delete process.env.OUTREACH_REPLY_TO;
    let d = reload().effectiveReplyDestination();
    assert.equal(d.address, SENDING);
    assert.equal(d.replyTo, '');
    assert.deepEqual(d.destinations, [SENDING]);
    assert.equal(d.agree, true);

    // OUTREACH_REPLY_TO set → that's where replies land.
    process.env.OUTREACH_REPLY_TO = READING;
    d = reload().effectiveReplyDestination();
    assert.equal(d.address, READING);

    // Multi-identity pool: a per-sender replyTo overrides the global one, and a
    // disagreeing set is exposed rather than hidden behind the primary.
    process.env.OUTREACH_SENDERS = JSON.stringify([
      { label: 'a', from: 'a@shop.com', replyTo: READING },
      { label: 'b', from: 'b@shop.com' }, // inherits the global OUTREACH_REPLY_TO
      { label: 'c', from: 'c@shop.com', replyTo: 'c@shop.com' },
    ]);
    d = reload().effectiveReplyDestination();
    assert.equal(d.address, READING);            // the primary's
    assert.equal(d.identities.length, 3);
    assert.equal(d.identities[1].destination, READING);
    assert.equal(d.identities[2].destination, 'c@shop.com');
    assert.deepEqual(d.destinations.sort(), [READING, 'c@shop.com'].sort());
    assert.equal(d.agree, false);
  } finally {
    for (const [k, v] of [['OUTREACH_EMAIL_FROM', saved.from], ['OUTREACH_REPLY_TO', saved.rt], ['OUTREACH_SENDERS', saved.senders]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[modPath];
    delete require.cache[poolPath];
    require('../../services/outreachEngine'); // restore the default-env module
  }
});
