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
