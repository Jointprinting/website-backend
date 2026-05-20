// services/__tests__/jpwAuditor.test.js
//
// Tests for the website auditor — specifically the HTML-parsing layer.
// We avoid network calls by monkey-patching axios.get with stubbed
// responses, so these run fast and offline.

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// Stub axios.get before requiring the auditor (auditor reads axios at module
// load via require, but only USES it inside auditUrl, so patching here is
// safe — we just swap the .get method on the live module reference).
let stubbedResponse = null;
const realGet = axios.get;
axios.get = async () => {
  if (!stubbedResponse) throw new Error('No stubbed response set');
  // Mimic the real-axios shape the auditor reads.
  return {
    status: stubbedResponse.status,
    data:   stubbedResponse.html,
    request: { res: { responseUrl: stubbedResponse.finalUrl || 'https://example.com/' } },
  };
};

const { auditUrl } = require('../jpwAuditor');

// Reset stub after the suite to avoid leaking state if other test files run
test.after(() => { axios.get = realGet; });

// ── Helpers ──────────────────────────────────────────────────────────────
function stub(html, { status = 200, finalUrl = 'https://example.com/' } = {}) {
  stubbedResponse = { html, status, finalUrl };
}

const STRONG_SITE = `
<!DOCTYPE html>
<html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acme Tree Service — South Jersey Tree Removal</title>
  <meta name="description" content="Family-owned tree service in Voorhees NJ. Call for a free estimate today.">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Acme Tree"}</script>
  <script async src="https://www.googletagmanager.com/gtag/js?id=AW-1"></script>
</head><body>
  <h1>South Jersey's #1 Tree Service</h1>
  <nav><a href="/services">Services</a><a href="/about">About</a></nav>
  <p>Proudly serving Voorhees, Marlton, Cherry Hill, and Mount Laurel.</p>
  <a href="tel:6095551234">Call (609) 555-1234</a>
  <a class="cta" href="/quote">Request a Free Estimate</a>
  <section><h2>What Our Customers Say</h2><blockquote>5-star service!</blockquote></section>
  <section><h2>Gallery</h2><img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg"><img src="/d.jpg"><img src="/e.jpg"><img src="/f.jpg"><img src="/g.jpg"><img src="/h.jpg"></section>
  <form><input type="email" name="email"><textarea name="message"></textarea></form>
  <iframe src="https://www.google.com/maps/embed?..."></iframe>
  <footer>© 2026 Acme Tree Service</footer>
</body></html>
`;

const WEAK_SITE = `
<!DOCTYPE html>
<html><head><title>Joe's Plumbing</title></head>
<body>
  <h1>Plumbing</h1>
  <p>Plumbing services. Call our number.</p>
  <footer>Copyright 2019 Joe</footer>
</body></html>
`;

const SOUTH_JERSEY_TOWNS = ['Voorhees', 'Marlton', 'Cherry Hill', 'Mount Laurel'];

// ── Tests ────────────────────────────────────────────────────────────────
test('Strong site: detects all the good signals', async () => {
  stub(STRONG_SITE);
  const r = await auditUrl('https://example.com/', { cityHints: SOUTH_JERSEY_TOWNS });
  assert.equal(r.loads_successfully, true);
  assert.equal(r.ssl_valid, true);
  assert.equal(r.has_mobile_viewport, true);
  assert.equal(r.has_title, true);
  assert.equal(r.has_meta_description, true);
  assert.equal(r.has_h1, true);
  assert.equal(r.has_visible_phone, true);
  assert.equal(r.has_click_to_call, true);
  assert.equal(r.has_contact_form, true);
  assert.equal(r.has_quote_cta, true);
  assert.equal(r.has_reviews_on_site, true);
  assert.equal(r.has_gallery, true);
  assert.equal(r.has_google_map_embed, true);
  assert.equal(r.has_schema, true);
  assert.equal(r.has_localbusiness_schema, true);
  assert.equal(r.has_tracking_pixels, true);
  assert.equal(r.has_service_area_terms, true);
  assert.ok(r.service_area_count >= 3, `expected ≥3 town hits, got ${r.service_area_count}`);
  assert.equal(r.outdated_copyright, false);
});

test('Weak site: flags the absence of every conversion signal', async () => {
  stub(WEAK_SITE);
  const r = await auditUrl('https://example.com/', { cityHints: SOUTH_JERSEY_TOWNS });
  assert.equal(r.loads_successfully, true);
  assert.equal(r.has_mobile_viewport, false);
  assert.equal(r.has_meta_description, false);
  assert.equal(r.has_click_to_call, false);
  assert.equal(r.has_contact_form, false);
  assert.equal(r.has_quote_cta, false);
  assert.equal(r.has_localbusiness_schema, false);
  assert.equal(r.outdated_copyright, true);
  assert.equal(r.has_service_area_terms, false);
});

test('Non-200 status: marks as failed but still returns an object', async () => {
  stub('<html></html>', { status: 404 });
  const r = await auditUrl('https://example.com/notfound');
  assert.equal(r.loads_successfully, false);
  assert.equal(r.status_code, 404);
});

test('Empty URL: returns clean failure shape, no crash', async () => {
  const r = await auditUrl('');
  assert.equal(r.loads_successfully, false);
  assert.match(r.notes, /No URL/);
});

test('CMS sniff: WordPress', async () => {
  stub(`<html><head><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head><body><h1>x</h1></body></html>`);
  const r = await auditUrl('https://example.com/');
  assert.equal(r.cms_detected, 'WordPress');
});

test('CMS sniff: Wix', async () => {
  stub(`<html><head><script src="https://static.wixstatic.com/x.js"></script></head><body><h1>x</h1></body></html>`);
  const r = await auditUrl('https://example.com/');
  assert.equal(r.cms_detected, 'Wix');
});

test('LocalBusiness subtype (RoofingContractor) is recognized', async () => {
  stub(`<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"RoofingContractor","name":"X"}</script></head><body><h1>X</h1></body></html>`);
  const r = await auditUrl('https://example.com/');
  assert.equal(r.has_localbusiness_schema, true);
});
