// services/__tests__/leadFinder.test.js
//
// Pure-logic checks for the free dispensary lead finder (no network, no DB):
//   node --test services/__tests__/leadFinder.test.js
//
// The Overpass query/parse (dispensaryFinder) and the email extraction/ranking
// (emailEnricher) are pure and exported, so the risky bits are covered here; the
// axios fetches are exercised live on the server.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOverpassQuery, osmAddress, normalizeWebsite, parseOverpassElements, isRegion,
  nextRegionAfter, decideFrontier, NATIONAL_ROLLOUT,
} = require('../dispensaryFinder');
const {
  sanitizeEmail, extractEmails, pickBestEmail, findContactLink, hostOf,
} = require('../emailEnricher');

// ── Overpass query ───────────────────────────────────────────────────────────
test('buildOverpassQuery embeds the bbox and asks for JSON + centers', () => {
  const q = buildOverpassQuery([38.85, -75.6, 41.36, -73.88]);
  assert.match(q, /\[out:json\]/);
  assert.match(q, /shop"="cannabis"\]\(38\.85,-75\.6,41\.36,-73\.88\)/);
  assert.match(q, /out center tags;/);
});

test('isRegion knows NJ and rejects junk', () => {
  assert.equal(isRegion('nj'), true);
  assert.equal(isRegion('ny'), true);
  assert.equal(isRegion('zz'), false);
  assert.equal(isRegion(''), false);
});

// ── Address assembly ─────────────────────────────────────────────────────────
test('osmAddress builds "street, city ST zip" and tolerates gaps', () => {
  assert.equal(
    osmAddress({ 'addr:housenumber': '12', 'addr:street': 'High St', 'addr:city': 'Trenton', 'addr:state': 'NJ', 'addr:postcode': '08601' }),
    '12 High St, Trenton NJ 08601',
  );
  assert.equal(osmAddress({ 'addr:city': 'Newark', 'addr:state': 'NJ' }), 'Newark NJ');
  assert.equal(osmAddress({}), '');
});

// ── Website normalization ────────────────────────────────────────────────────
test('normalizeWebsite forces a fetchable URL or drops it', () => {
  assert.equal(normalizeWebsite('https://greenleaf.com'), 'https://greenleaf.com');
  assert.equal(normalizeWebsite('greenleaf.com'), 'http://greenleaf.com');
  assert.equal(normalizeWebsite('www.greenleaf.com'), 'http://www.greenleaf.com');
  assert.equal(normalizeWebsite('/relative/path'), '');
  assert.equal(normalizeWebsite(''), '');
});

// ── Overpass parse ───────────────────────────────────────────────────────────
test('parseOverpassElements keeps named shops, grabs OSM emails, dedupes', () => {
  const rows = parseOverpassElements({
    elements: [
      { type: 'node', id: 1, tags: { name: 'Green Leaf', 'addr:city': 'Trenton', 'addr:state': 'NJ', 'contact:email': 'INFO@greenleaf.com', website: 'greenleaf.com', phone: '609-555-0142' } },
      { type: 'way', id: 2, tags: { name: 'The Botanist', 'addr:housenumber': '5', 'addr:street': 'Main St', 'addr:city': 'Egg Harbor Township', 'addr:state': 'NJ' } },
      { type: 'node', id: 3, tags: { /* no name */ 'addr:city': 'Camden' } },        // dropped
      { type: 'node', id: 4, tags: { name: 'Green Leaf', 'addr:city': 'Trenton', 'addr:state': 'NJ' } }, // dup name+addr → dropped
    ],
  });
  assert.equal(rows.length, 2);
  const gl = rows.find((r) => r.name === 'Green Leaf');
  assert.equal(gl.email, 'info@greenleaf.com');            // lowercased, from OSM
  assert.equal(gl.website, 'http://greenleaf.com');        // normalized
  assert.equal(gl.osmId, 'node/1');
  const bot = rows.find((r) => r.name === 'The Botanist');
  assert.equal(bot.address, '5 Main St, Egg Harbor Township NJ');
  assert.equal(bot.email, '');
});

test('parseOverpassElements handles empty / malformed input', () => {
  assert.deepEqual(parseOverpassElements({}), []);
  assert.deepEqual(parseOverpassElements(null), []);
  assert.deepEqual(parseOverpassElements({ elements: 'nope' }), []);
});

// ── Email sanitizing ─────────────────────────────────────────────────────────
test('sanitizeEmail accepts real addresses and rejects junk', () => {
  assert.equal(sanitizeEmail('INFO@GreenLeaf.com'), 'info@greenleaf.com');
  assert.equal(sanitizeEmail('  sales@shop.co.  '), 'sales@shop.co');
  assert.equal(sanitizeEmail('hello@shop.com?subject=hi'), 'hello@shop.com');
  assert.equal(sanitizeEmail('logo@2x.png'), '');            // asset
  assert.equal(sanitizeEmail('a@sentry.wixpress.com'), '');  // tracking noise
  assert.equal(sanitizeEmail('you@example.com'), '');        // placeholder domain
  assert.equal(sanitizeEmail('your@email.com'), '');         // placeholder local
  assert.equal(sanitizeEmail('noreply@shop.com'), '');       // no-reply
  assert.equal(sanitizeEmail('deadbeefdeadbeef@shop.com'), '');// hex-blob local
  assert.equal(sanitizeEmail('not-an-email'), '');
  assert.equal(sanitizeEmail(''), '');
});

// ── Email extraction (mailto first, then text) ───────────────────────────────
test('extractEmails pulls mailto links ahead of body text, deduped', () => {
  const html = `
    <a href="mailto:info@greenleaf.com?subject=Hi">Email us</a>
    <p>Wholesale: sales@greenleaf.com or info@greenleaf.com</p>
    <img src="hero@2x.png">
  `;
  const emails = extractEmails(html);
  assert.equal(emails[0], 'info@greenleaf.com'); // mailto wins the ordering
  assert.ok(emails.includes('sales@greenleaf.com'));
  assert.equal(emails.filter((e) => e === 'info@greenleaf.com').length, 1); // deduped
  assert.ok(!emails.some((e) => e.includes('.png')));
});

// ── Email ranking ────────────────────────────────────────────────────────────
test('pickBestEmail prefers role inboxes, then the site’s own domain', () => {
  assert.equal(
    pickBestEmail(['owner.personal@gmail.com', 'info@greenleaf.com'], 'greenleaf.com'),
    'info@greenleaf.com',
  );
  // No role match: the on-domain address beats an off-domain one.
  assert.equal(
    pickBestEmail(['someguy@gmail.com', 'jane@greenleaf.com'], 'greenleaf.com'),
    'jane@greenleaf.com',
  );
  // Role order: info beats sales.
  assert.equal(pickBestEmail(['sales@x.com', 'info@x.com'], 'x.com'), 'info@x.com');
  assert.equal(pickBestEmail([], 'x.com'), '');
});

// ── Contact-link discovery ───────────────────────────────────────────────────
test('findContactLink finds a same-site contact page, ignores off-site + mailto', () => {
  const html = `
    <a href="/about/contact-us">Contact</a>
    <a href="https://facebook.com/greenleaf">FB</a>
    <a href="mailto:info@greenleaf.com">mail</a>
  `;
  assert.equal(findContactLink(html, 'https://greenleaf.com/'), 'https://greenleaf.com/about/contact-us');
  assert.equal(findContactLink('<a href="/menu">Menu</a>', 'https://greenleaf.com/'), '');
});

test('hostOf strips www and lowercases', () => {
  assert.equal(hostOf('https://WWW.GreenLeaf.com/contact'), 'greenleaf.com');
  assert.equal(hostOf('not a url'), '');
});

// ── Auto-advancing frontier ──────────────────────────────────────────────────
test('NATIONAL_ROLLOUT starts at NJ and every id is a real region', () => {
  assert.equal(NATIONAL_ROLLOUT[0], 'nj');
  for (const id of NATIONAL_ROLLOUT) assert.equal(isRegion(id), true, `unknown region "${id}"`);
});

test('nextRegionAfter steps forward and wraps at the end', () => {
  assert.equal(nextRegionAfter('nj'), 'ny');
  assert.equal(nextRegionAfter('ny'), 'pa');
  assert.equal(nextRegionAfter(NATIONAL_ROLLOUT[NATIONAL_ROLLOUT.length - 1]), 'nj'); // wraps
  assert.equal(nextRegionAfter('zz'), 'nj'); // unknown → start
});

test('decideFrontier: new leads reset the streak and hold the region', () => {
  assert.deepEqual(
    decideFrontier({ region: 'nj', created: 4, dryStreak: 1 }),
    { region: 'nj', dryStreak: 0, advanced: false },
  );
});

test('decideFrontier: advances only after N consecutive dry sweeps', () => {
  // First dry sweep — hold, streak → 1.
  assert.deepEqual(
    decideFrontier({ region: 'nj', created: 0, dryStreak: 0, advanceAfter: 2 }),
    { region: 'nj', dryStreak: 1, advanced: false },
  );
  // Second dry sweep — advance to NY, reset streak.
  assert.deepEqual(
    decideFrontier({ region: 'nj', created: 0, dryStreak: 1, advanceAfter: 2 }),
    { region: 'ny', dryStreak: 0, advanced: true },
  );
});
