// controllers/__tests__/jpwSites.test.js
//
// JP Webworks site builder — pure-logic checks (no DB):
//
//   node --test controllers/__tests__/jpwSites.test.js
//
// slugifySiteName / sanitizeSiteUpdate / publicSiteView are exported from
// controllers/jpwSites.js and take plain values. The route handlers are
// DB-bound and exercised live; the risky logic (slugs, the update whitelist,
// what the public endpoint may reveal) is all here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugifySiteName,
  sanitizeSiteUpdate,
  sanitizeEditUpdate,
  publicSiteView,
  healthFromHttpStatus,
  SITE_STATUSES,
} = require('../jpwSites');

// ── Slugs (the public preview URL part) ───────────────────────────────────────
test('slugifySiteName produces clean url-safe slugs', () => {
  assert.equal(slugifySiteName('Cape May Brewing Co.'), 'cape-may-brewing-co');
  assert.equal(slugifySiteName("Manny's Corner Deli & Grill"), 'mannys-corner-deli-and-grill');
  assert.equal(slugifySiteName('  --Weird   Spacing--  '), 'weird-spacing');
  assert.equal(slugifySiteName('Café Décor'), 'cafe-decor');           // accents stripped
  assert.equal(slugifySiteName(''), 'site');                           // never blank
  assert.equal(slugifySiteName('!!!'), 'site');
  assert.ok(slugifySiteName('x'.repeat(200)).length <= 60);            // capped
});

// ── Update whitelist (what a PUT can and cannot change) ───────────────────────
test('sanitizeSiteUpdate whitelists fields and validates status', () => {
  const { set } = sanitizeSiteUpdate({
    name: '  Shore Smoke Shop  ', businessType: 'retail', templateId: 'retail',
    status: 'preview', domain: 'https://ShoreSmoke.com/home', data: { businessName: 'Shore Smoke' },
    slug: 'hack-attempt', _id: 'nope', createdAt: 'nope',              // not whitelisted → ignored
  });
  assert.equal(set.name, 'Shore Smoke Shop');
  assert.equal(set.status, 'preview');
  assert.equal(set.domain, 'shoresmoke.com');                          // scheme/path stripped, lowercased
  assert.deepEqual(set.data, { businessName: 'Shore Smoke' });
  assert.equal('slug' in set, false);                                  // slug immutable via update
  assert.equal('_id' in set, false);
});

test('sanitizeSiteUpdate rejects bad values with a reason', () => {
  assert.match(sanitizeSiteUpdate({ status: 'published' }).error, /status must be one of/);
  assert.match(sanitizeSiteUpdate({ name: '   ' }).error, /name cannot be blank/);
  assert.match(sanitizeSiteUpdate({ templateId: '' }).error, /templateId cannot be blank/);
  assert.match(sanitizeSiteUpdate({ data: ['not', 'an', 'object'] }).error, /data must be an object/);
  // Oversized data blob is refused, not truncated.
  const big = { blob: 'x'.repeat(200 * 1024) };
  assert.match(sanitizeSiteUpdate({ data: big }).error, /data too large/);
  // Statuses stay in lockstep with the model enum.
  assert.deepEqual(SITE_STATUSES, ['draft', 'preview', 'live']);
});

test('sanitizeSiteUpdate: empty body → empty set (route turns that into a 400)', () => {
  assert.deepEqual(sanitizeSiteUpdate({}), { set: {} });
  assert.deepEqual(sanitizeSiteUpdate(), { set: {} });
});

// ── Public view (what an unauthenticated request can see) ─────────────────────
test('publicSiteView exposes render fields only — no _id, domain, or timestamps', () => {
  const view = publicSiteView({
    _id: 'secret', slug: 'shore-smoke', name: 'Shore Smoke Shop', templateId: 'retail',
    businessType: 'retail', status: 'preview', domain: 'shoresmoke.com',
    data: { businessName: 'Shore Smoke' }, createdAt: new Date(), updatedAt: new Date(),
  });
  assert.deepEqual(Object.keys(view).sort(), ['businessType', 'data', 'name', 'slug', 'status', 'templateId']);
  assert.equal(view.slug, 'shore-smoke');
  assert.equal('_id' in view, false);
  assert.equal('domain' in view, false);
  assert.equal(publicSiteView(null), null);
});

// ── Spine link: companyKey is whitelisted; '' clears it ───────────────────────
test('sanitizeSiteUpdate: companyKey joins the site to a CRM company', () => {
  assert.equal(sanitizeSiteUpdate({ companyKey: '  earl-and-toms  ' }).set.companyKey, 'earl-and-toms');
  assert.equal(sanitizeSiteUpdate({ companyKey: '' }).set.companyKey, ''); // clear the link
});

// ── Edit-update whitelist (the atomic edits.$[e] $set builder) ────────────────
test('sanitizeEditUpdate builds positional $set keys and validates status', () => {
  const done = sanitizeEditUpdate({ status: 'done' });
  assert.equal(done.set['edits.$[e].status'], 'done');
  assert.ok(done.set['edits.$[e].doneAt'] instanceof Date);          // done stamps a completion time
  const prog = sanitizeEditUpdate({ status: 'in_progress', body: '  fix the hero copy  ' });
  assert.equal(prog.set['edits.$[e].status'], 'in_progress');
  assert.equal(prog.set['edits.$[e].doneAt'], null);                 // non-done clears it
  assert.equal(prog.set['edits.$[e].body'], 'fix the hero copy');    // trimmed
});

test('sanitizeEditUpdate rejects a blank body and an unknown status', () => {
  assert.match(sanitizeEditUpdate({ body: '   ' }).error, /edit text cannot be blank/);
  assert.match(sanitizeEditUpdate({ status: 'archived' }).error, /status must be one of/);
  // Empty body → empty set (the route turns that into a 400), never a silent no-op save.
  assert.deepEqual(sanitizeEditUpdate({}).set, {});
});

// ── Site-health derivation from an HTTP status code ───────────────────────────
test('healthFromHttpStatus: 2xx/3xx ok, everything else down', () => {
  assert.equal(healthFromHttpStatus(200), 'ok');
  assert.equal(healthFromHttpStatus(301), 'ok');
  assert.equal(healthFromHttpStatus(399), 'ok');
  assert.equal(healthFromHttpStatus(404), 'down');
  assert.equal(healthFromHttpStatus(500), 'down');
  assert.equal(healthFromHttpStatus(null), 'down');  // fetch failed → no code
  assert.equal(healthFromHttpStatus(NaN), 'down');
});

// ── Hostname routing for connected client domains ─────────────────────────────
const { normalizeHost } = require('../jpwSites');
test('normalizeHost: lowercase, port stripped, www-insensitive', () => {
  assert.equal(normalizeHost('Shop.com'), 'shop.com');
  assert.equal(normalizeHost('shop.com:443'), 'shop.com');
  assert.equal(normalizeHost('www.Shop.com'), 'shop.com');
  assert.equal(normalizeHost('WWW.shop.com:8080'), 'shop.com');
  assert.equal(normalizeHost('  sub.shop.com '), 'sub.shop.com'); // subdomains kept (only www strips)
  assert.equal(normalizeHost(''), '');
  assert.equal(normalizeHost(null), '');
});
