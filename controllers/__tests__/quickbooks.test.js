// controllers/__tests__/quickbooks.test.js
// Pure pieces of the QuickBooks OAuth controller (no network, no DB):
//   node --test controllers/__tests__/quickbooks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAuthUrl, applyToken, _SCOPE, _REDIRECT_URI, API_BASE } = require('../quickbooks');

test('buildAuthUrl points at Intuit authorize with the correct params', () => {
  const url = buildAuthUrl('abc123');
  assert.ok(url.startsWith('https://appcenter.intuit.com/connect/oauth2?'), url);
  const q = new URL(url).searchParams;
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.equal(_SCOPE, 'com.intuit.quickbooks.accounting');
  assert.equal(q.get('state'), 'abc123');
  assert.equal(q.get('redirect_uri'), _REDIRECT_URI);
  assert.ok(q.has('client_id'));            // present even when unset (empty in tests)
});

test('production API base by default (not sandbox)', () => {
  assert.equal(API_BASE, 'https://quickbooks.api.intuit.com');
});

test('applyToken copies tokens and computes both expiries', () => {
  const auth = {};
  const before = Date.now();
  applyToken(auth, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, x_refresh_token_expires_in: 8726400 });
  assert.equal(auth.accessToken, 'AT');
  assert.equal(auth.refreshToken, 'RT');
  assert.ok(auth.accessTokenExpiresAt instanceof Date);
  assert.ok(auth.accessTokenExpiresAt.getTime() >= before + 3600 * 1000 - 500);
  assert.ok(auth.refreshTokenExpiresAt.getTime() >= before + 8726400 * 1000 - 500);
});

test('applyToken preserves an existing refresh token when a response omits it', () => {
  const auth = { refreshToken: 'OLD' };
  applyToken(auth, { access_token: 'AT2', expires_in: 3600 });
  assert.equal(auth.accessToken, 'AT2');
  assert.equal(auth.refreshToken, 'OLD');
});

test('applyToken falls back to a 1h access expiry when expires_in is missing', () => {
  const auth = {};
  const before = Date.now();
  applyToken(auth, { access_token: 'AT' });
  assert.ok(auth.accessTokenExpiresAt.getTime() >= before + 3600 * 1000 - 500);
});
