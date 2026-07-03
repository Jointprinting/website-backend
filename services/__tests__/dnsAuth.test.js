// services/__tests__/dnsAuth.test.js
//
// The pure email-auth classifier (utils/dnsAuth.js). The DNS resolution itself
// is network-bound and exercised live; here we pin the red/amber/green logic +
// the "never gate on unknown" safety rule.
//
//   node --test services/__tests__/dnsAuth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyAuth, domainOf } = require('../../utils/dnsAuth');

test('green: SPF + DKIM + enforcing DMARC', () => {
  const r = classifyAuth({ domain: 'jointprinting.com', spf: true, dkim: true, dmarc: true, dmarcPolicy: 'quarantine' });
  assert.equal(r.level, 'green');
  assert.equal(r.gateOk, true);
  assert.equal(r.issues.length, 0);
});

test('amber: has SPF + DMARC but DKIM unseen or p=none', () => {
  const noDkim = classifyAuth({ domain: 'x.com', spf: true, dkim: false, dmarc: true, dmarcPolicy: 'reject' });
  assert.equal(noDkim.level, 'amber');
  assert.equal(noDkim.gateOk, true); // amber still sends
  const pNone = classifyAuth({ domain: 'x.com', spf: true, dkim: true, dmarc: true, dmarcPolicy: 'none' });
  assert.equal(pNone.level, 'amber');
  assert.ok(pNone.issues.some((i) => /p=none/i.test(i)));
});

test('red: missing SPF or DMARC → holds sends', () => {
  const noSpf = classifyAuth({ domain: 'x.com', spf: false, dkim: true, dmarc: true, dmarcPolicy: 'reject' });
  assert.equal(noSpf.level, 'red');
  assert.equal(noSpf.gateOk, false);
  const noDmarc = classifyAuth({ domain: 'x.com', spf: true, dkim: true, dmarc: false });
  assert.equal(noDmarc.level, 'red');
  assert.equal(noDmarc.gateOk, false);
});

test('unknown: no domain or DNS unreachable NEVER holds (avoids false blocks)', () => {
  const noDomain = classifyAuth({ domain: '' });
  assert.equal(noDomain.level, 'unknown');
  assert.equal(noDomain.gateOk, true);
  const unreachable = classifyAuth({ domain: 'x.com', reachable: false });
  assert.equal(unreachable.level, 'unknown');
  assert.equal(unreachable.gateOk, true);
});

test('domainOf pulls the host from an address or bare domain', () => {
  assert.equal(domainOf('Nate <nate@Mail.JointPrinting.com>'), 'mail.jointprinting.com');
  assert.equal(domainOf('outreach@getjp.com'), 'getjp.com');
  assert.equal(domainOf('getjp.com'), 'getjp.com');
  assert.equal(domainOf(''), '');
});

// ── recommendedRecords — the exact fix-it rows the Studio renders ────────────
const { recommendedRecords } = require('../../utils/dnsAuth');

test('recommendedRecords: DKIM missing + DMARC p=none → dkim row + optional dmarc upgrade', () => {
  const recs = recommendedRecords({ domain: 'jointprintingshop.com', spf: true, dkim: false, dmarc: true, dmarcPolicy: 'none' });
  const ids = recs.map((r) => r.id);
  assert.deepEqual(ids, ['dkim', 'dmarc-upgrade']);
  assert.match(recs[0].value, /SendPulse/);
  assert.match(recs[1].value, /p=quarantine/);
  assert.match(recs[1].note, /Not required to send/);
});

test('recommendedRecords: nothing set → spf + dkim + dmarc rows with paste-able values', () => {
  const recs = recommendedRecords({ domain: 'x.com', spf: false, dkim: false, dmarc: false });
  assert.deepEqual(recs.map((r) => r.id), ['spf', 'dkim', 'dmarc']);
  assert.equal(recs[0].host, '@');
  assert.match(recs[0].value, /^v=spf1 /);
  assert.match(recs[2].value, /^v=DMARC1/);
});

test('recommendedRecords: fully green → empty (panel hides)', () => {
  assert.deepEqual(recommendedRecords({ domain: 'x.com', spf: true, dkim: true, dmarc: true, dmarcPolicy: 'quarantine' }), []);
});

test('recommendedRecords: unknown posture (DNS unreachable) recommends NOTHING — flags are false from zero data', () => {
  assert.deepEqual(recommendedRecords({ domain: 'x.com', level: 'unknown', spf: false, dkim: false, dmarc: false }), []);
  assert.deepEqual(recommendedRecords({ domain: '', spf: false, dkim: false, dmarc: false }), []);
});
