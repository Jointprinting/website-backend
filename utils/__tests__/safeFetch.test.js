// utils/__tests__/safeFetch.test.js
//
//   node --test utils/__tests__/safeFetch.test.js
//
// Several places fetch a URL the app did not choose: a company website scraped
// off OpenStreetMap, a site being audited, an image referenced by a document.
// Overpass is a public wiki — anyone can edit a `website=` tag on a node.
//
// Fetched from inside the API host, http://169.254.169.254/... reaches things
// the public internet cannot. The enricher then REGEXES THE RESPONSE BODY FOR
// EMAILS and shows the outcome in the Studio, which turns an ordinary scrape
// into a clean read oracle for the host's own network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkUrl, isPrivateAddress, isPrivateIPv4, isPrivateIPv6, safeGet } = require('../safeFetch');

test('an ordinary company website is fine', () => {
  assert.equal(checkUrl('https://example.com/contact').ok, true);
  assert.equal(checkUrl('http://shop.example.co.uk').ok, true);
});

test('THE ONE THAT MATTERS: the cloud metadata endpoint is refused', () => {
  const r = checkUrl('http://169.254.169.254/latest/meta-data/');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'private-address');
});

test('loopback and the local network are refused', () => {
  for (const u of [
    'http://127.0.0.1:27017',
    'http://localhost:3000',
    'http://10.0.0.5/admin',
    'http://192.168.1.1',
    'http://172.16.4.4',
    'http://[::1]:8080',
    'http://printer.local',
    'http://svc.internal/health',
  ]) {
    assert.equal(checkUrl(u).ok, false, `${u} should be refused`);
  }
});

test('an IPv4-mapped IPv6 address reaches the same place, and is refused too', () => {
  // ::ffff:169.254.169.254 is the metadata endpoint wearing a different hat.
  assert.equal(isPrivateIPv6('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateIPv6('::ffff:8.8.8.8'), false);
});

test('only http and https', () => {
  // file:// reads the container's disk. gopher:// has a history of protocol
  // smuggling.
  for (const u of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/html,x']) {
    const r = checkUrl(u);
    assert.equal(r.ok, false, `${u} should be refused`);
    assert.match(r.reason, /blocked-scheme/);
  }
});

test('credentials in a URL are refused', () => {
  // A redirect-laundering trick, and never present in a real company website
  // link.
  assert.equal(checkUrl('http://user:pass@example.com').reason, 'credentials-in-url');
});

test('garbage is refused rather than thrown on', () => {
  assert.equal(checkUrl('').ok, false);
  assert.equal(checkUrl(null).ok, false);
  assert.equal(checkUrl('not a url at all').ok, false);
});

test('the IPv4 ranges are the ones intended', () => {
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('172.32.0.1'), false);   // just OUTSIDE 172.16–31
  assert.equal(isPrivateIPv4('172.16.0.1'), true);
  assert.equal(isPrivateIPv4('172.31.255.255'), true);
  assert.equal(isPrivateIPv4('100.64.0.1'), true);    // CGNAT
  assert.equal(isPrivateIPv4('0.0.0.0'), true);
  assert.equal(isPrivateIPv4('224.0.0.1'), true);     // multicast
});

test('a hostname is not treated as an address', () => {
  assert.equal(isPrivateAddress('example.com'), false);
  assert.equal(isPrivateAddress('localhost'), true);
});

// ── The redirect hop is the part that is easy to get wrong ──────────────────

test('EVERY redirect hop is re-checked, not just the first URL', async () => {
  // The attacker controls the server that issues the 302. Validating only the
  // first URL is no protection at all — this is the actual exploit path.
  const calls = [];
  const fakeAxios = {
    get: async (url) => {
      calls.push(url);
      if (url === 'https://example.com/') {
        return { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' }, data: '' };
      }
      return { status: 200, headers: {}, data: 'SECRETS' };
    },
  };

  await assert.rejects(
    () => safeGet(fakeAxios, 'https://example.com/'),
    (e) => e.code === 'UNSAFE_URL' && e.reason === 'private-address',
  );
  // It fetched the first URL and then STOPPED — the metadata endpoint was never
  // requested.
  assert.deepEqual(calls, ['https://example.com/']);
});

test('an ordinary redirect chain still works', async () => {
  const fakeAxios = {
    get: async (url) => {
      if (url === 'http://example.com/') {
        return { status: 301, headers: { location: 'https://example.com/home' }, data: '' };
      }
      return { status: 200, headers: {}, data: 'PAGE' };
    },
  };
  const res = await safeGet(fakeAxios, 'http://example.com/');
  assert.equal(res.status, 200);
  assert.equal(res.data, 'PAGE');
});

test('a redirect loop stops instead of spinning', async () => {
  const fakeAxios = {
    get: async () => ({ status: 302, headers: { location: 'https://example.com/loop' }, data: '' }),
  };
  await assert.rejects(
    () => safeGet(fakeAxios, 'https://example.com/loop', {}, { maxRedirects: 3 }),
    (e) => e.code === 'TOO_MANY_REDIRECTS',
  );
});

test('the caller keeps its own timeout, size cap and headers', async () => {
  // safeGet wraps rather than replaces: each caller already tuned these, and
  // silently changing them would change behaviour beyond the security fix.
  let seen = null;
  const fakeAxios = { get: async (_u, opts) => { seen = opts; return { status: 200, headers: {}, data: '' }; } };
  await safeGet(fakeAxios, 'https://example.com/', { timeout: 4321, maxContentLength: 999, headers: { 'User-Agent': 'JP' } });
  assert.equal(seen.timeout, 4321);
  assert.equal(seen.maxContentLength, 999);
  assert.equal(seen.headers['User-Agent'], 'JP');
  // …but redirects are taken over, because that is the whole point.
  assert.equal(seen.maxRedirects, 0);
});
