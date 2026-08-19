// WHAT A CLIENT-FACING IMAGE IS ALLOWED TO BE.
//
// A mockup side falls back to its bare garment photo when no art was flattened
// onto it, and that photo is usually an S&S CDN URL. The R2 offload passes any
// non-base64 value through untouched, so the supplier's URL was served straight
// to the client — where it does not load. Every design showed its front beside
// a dead back.
//
// Set the R2 env BEFORE requiring anything: services/r2 reads it at module load,
// and this file needs the CONFIGURED behaviour, not the dev pass-through.
process.env.R2_ACCOUNT_ID = 'acct';
process.env.R2_ACCESS_KEY_ID = 'key';
process.env.R2_SECRET_ACCESS_KEY = 'secret';
process.env.R2_BUCKET = 'bucket';
process.env.R2_PUBLIC_BASE_URL = 'https://img.jointprinting.com';

const test = require('node:test');
const assert = require('node:assert');
const { _clientImage } = require('../approval');

test('an object in our own bucket is served', () => {
  assert.strictEqual(
    _clientImage('https://img.jointprinting.com/mockups/img/abc.png'),
    'https://img.jointprinting.com/mockups/img/abc.png',
  );
});

test('an inline data URI is served — it is ours by definition', () => {
  assert.strictEqual(_clientImage('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

test("the supplier's CDN photo is NOT served — this is the dead back", () => {
  assert.strictEqual(_clientImage('https://cdn.ssactivewear.com/Images/Color/123_fm.jpg'), '');
});

test('nor any other host we do not control', () => {
  assert.strictEqual(_clientImage('https://example.com/whatever.png'), '');
  assert.strictEqual(_clientImage('http://img.jointprinting.com.evil.test/x.png'), '');
});

test('empty and junk resolve to nothing rather than an <img src> that cannot load', () => {
  assert.strictEqual(_clientImage(''), '');
  assert.strictEqual(_clientImage('   '), '');
  assert.strictEqual(_clientImage(null), '');
  assert.strictEqual(_clientImage(undefined), '');
  assert.strictEqual(_clientImage(42), '');
  assert.strictEqual(_clientImage({}), '');
});

test('a non-image data URI is refused', () => {
  assert.strictEqual(_clientImage('data:text/html;base64,PHNjcmlwdD4='), '');
});
