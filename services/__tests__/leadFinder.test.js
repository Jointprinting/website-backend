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
  nextRegionAfter, decideFrontier, NATIONAL_ROLLOUT, isQualityLead, isClosedPoi, hasCannabisTag,
  isBigChain, markChains, FINDER_VERSION,
} = require('../dispensaryFinder');
const {
  sanitizeEmail, extractEmails, pickBestEmail, findContactLink, hostOf,
  rankContactLinks, decodeCfemail, decodeEntities, deobfuscate,
} = require('../emailEnricher');
const {
  isTransientDnsError, isDisposableDomain, partitionDeliverable,
} = require('../emailVerify');
const { selectImportable } = require('../leadFinderRunner');

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
      { type: 'node', id: 1, tags: { name: 'Green Leaf', shop: 'cannabis', 'addr:city': 'Trenton', 'addr:state': 'NJ', 'contact:email': 'INFO@greenleaf.com', website: 'greenleaf.com', phone: '609-555-0142' } },
      { type: 'way', id: 2, tags: { name: 'The Botanist', shop: 'cannabis', 'addr:housenumber': '5', 'addr:street': 'Main St', 'addr:city': 'Egg Harbor Township', 'addr:state': 'NJ' } },
      { type: 'node', id: 3, tags: { /* no name */ shop: 'cannabis', 'addr:city': 'Camden' } },        // dropped (no name)
      { type: 'node', id: 4, tags: { name: 'Green Leaf', shop: 'cannabis', 'addr:city': 'Trenton', 'addr:state': 'NJ' } }, // dup name+addr → dropped
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

// ── Quality gate — keep the widened net junk-free ─────────────────────────────
test('isQualityLead: trusts cannabis tags, filters junk names, drops closed', () => {
  // Trusted cannabis tags — always in.
  assert.equal(isQualityLead({ shop: 'cannabis' }, 'Green Leaf'), true);
  assert.equal(isQualityLead({ office: 'cannabis' }, 'Rise'), true);
  assert.equal(isQualityLead({ shop: 'weed' }, 'The Botanist'), true);
  // Name-only "dispensary" with no cannabis tag — in, IF it's really cannabis.
  assert.equal(isQualityLead({ shop: 'yes' }, 'Garden State Dispensary'), true);
  assert.equal(isQualityLead({}, 'Curaleaf Dispensary'), true);
  // Non-cannabis "dispensary" — OUT (pharmacy, vet, etc.).
  assert.equal(isQualityLead({}, 'CVS Pharmacy Dispensary'), false);
  assert.equal(isQualityLead({}, 'Animal Hospital Veterinary Dispensary'), false);
  assert.equal(isQualityLead({}, 'Downtown Smoke Shop Dispensary'), false);
  assert.equal(isQualityLead({}, 'Vape & Dispensary'), false);
  // Name doesn't say dispensary and no cannabis tag — OUT.
  assert.equal(isQualityLead({ shop: 'convenience' }, 'Joe’s Corner Store'), false);
});

test('isClosedPoi: lifecycle-prefixed / status-closed POIs are excluded', () => {
  assert.equal(isClosedPoi({ 'disused:shop': 'cannabis' }), true);
  assert.equal(isClosedPoi({ 'was:name': 'Old Dispensary' }), true);
  assert.equal(isClosedPoi({ shop: 'vacant' }), true);
  assert.equal(isClosedPoi({ business_status: 'CLOSED' }), true);
  assert.equal(isClosedPoi({ shop: 'cannabis' }), false);
  // A closed cannabis shop is a quality FAIL even with the trusted tag.
  assert.equal(isQualityLead({ 'disused:shop': 'cannabis', shop: 'cannabis' }, 'Gone Green'), false);
});

test('parseOverpassElements applies the quality gate', () => {
  const rows = parseOverpassElements({
    elements: [
      { type: 'node', id: 1, tags: { name: 'Green Leaf', shop: 'cannabis', 'addr:city': 'Trenton', 'addr:state': 'NJ' } },
      { type: 'node', id: 2, tags: { name: 'Rite Aid Pharmacy Dispensary', 'addr:city': 'Camden' } }, // junk → dropped
      { type: 'node', id: 3, tags: { name: 'Old Weed Co', 'disused:shop': 'cannabis' } },              // closed → dropped
      { type: 'node', id: 4, tags: { name: 'Garden State Dispensary', 'addr:state': 'NJ' } },           // real → kept
    ],
  });
  assert.deepEqual(rows.map((r) => r.name).sort(), ['Garden State Dispensary', 'Green Leaf']);
});

test('buildOverpassQuery widens by name but only to "dispensary"', () => {
  const q = buildOverpassQuery([38.85, -75.6, 41.36, -73.88]);
  assert.match(q, /name"~"dispensary",i/);      // widened net
  assert.doesNotMatch(q, /marijuana/);          // deliberately NOT the noisy terms
});

test('buildOverpassQuery also nets OSM cannabis:* detail tags', () => {
  const q = buildOverpassQuery([38.85, -75.6, 41.36, -73.88]);
  // Dispensaries a mapper tagged with details but never shop=cannabis — a real
  // NJ coverage gap the detail-tag net closes.
  assert.match(q, /node\["cannabis:recreational"\]/);
  assert.match(q, /way\["cannabis:medical"\]/);
});

test('hasCannabisTag trusts cannabis:* detail tags, not just shop=cannabis', () => {
  assert.equal(hasCannabisTag({ shop: 'cannabis' }), true);
  assert.equal(hasCannabisTag({ 'cannabis:recreational': 'yes' }), true);
  // Medical-only shops tag rec=no but are still real dispensary leads.
  assert.equal(hasCannabisTag({ 'cannabis:recreational': 'no', 'cannabis:medical': 'yes' }), true);
  assert.equal(hasCannabisTag({ shop: 'bakery' }), false);
});

test('parseOverpassElements keeps a detail-tagged shop with no shop=cannabis', () => {
  const rows = parseOverpassElements({
    elements: [
      // No shop=cannabis and the name doesn't say "dispensary" — only the detail
      // tag identifies it. The old net dropped this; the widened one keeps it.
      { type: 'node', id: 9, tags: { name: 'Garden State Wellness', 'cannabis:recreational': 'yes' } },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Garden State Wellness');
});

test('FINDER_VERSION is a positive integer the engine stamps on every run', () => {
  assert.equal(Number.isInteger(FINDER_VERSION), true);
  assert.ok(FINDER_VERSION >= 1);
});

// ── Import selection (email-optional yield lever) ─────────────────────────────
test('selectImportable keeps email-LESS dispensaries (phone/visit leads)', () => {
  const out = selectImportable([
    { name: 'Emailable Shop', email: 'info@shop.com', chain: false },
    { name: 'Phone-only Shop', email: '', phone: '555-1212', chain: false }, // kept now
  ]);
  assert.equal(out.length, 2);
  assert.ok(out.some((c) => c.name === 'Phone-only Shop'));
});

test('selectImportable drops chains and de-dupes shared inboxes', () => {
  const out = selectImportable([
    { name: 'Curaleaf X', email: 'a@curaleaf.com', chain: true },   // chain → dropped
    { name: 'Indie A', email: 'shared@x.com', chain: false },
    { name: 'Indie B', email: 'shared@x.com', chain: false },       // same inbox → dropped
    { name: 'Indie C', email: '', chain: false },                   // email-less → kept
  ]);
  assert.deepEqual(out.map((c) => c.name), ['Indie A', 'Indie C']);
});

test('selectImportable can include chains when skipChains is off', () => {
  const out = selectImportable(
    [{ name: 'Curaleaf X', email: 'a@curaleaf.com', chain: true }],
    { skipChains: false },
  );
  assert.equal(out.length, 1);
});

// ── Big-chain / MSO detection ─────────────────────────────────────────────────
test('isBigChain: known MSOs + brand:wikidata are chains, independents are not', () => {
  assert.equal(isBigChain({ 'brand:wikidata': 'Q123' }, 'Some Shop'), true); // OSM-recognized brand
  assert.equal(isBigChain({ brand: 'Curaleaf' }, 'Curaleaf Bellmawr'), true);
  assert.equal(isBigChain({}, 'Trulieve Dispensary'), true);
  assert.equal(isBigChain({}, 'Sunnyside Cannabis'), true);
  assert.equal(isBigChain({}, 'RISE Dispensary Paterson'), true);
  // A genuine independent — not a chain.
  assert.equal(isBigChain({}, 'Green Leaf Dispensary'), false);
  assert.equal(isBigChain({ brand: '' }, 'Nate’s Corner Dispensary'), false);
});

test('markChains: a brand repeating across the batch is flagged even if unknown', () => {
  const marked = markChains([
    { name: 'ZZ Cannabis A', brand: 'ZZ Cannabis' },
    { name: 'ZZ Cannabis B', brand: 'ZZ Cannabis' },
    { name: 'ZZ Cannabis C', brand: 'ZZ Cannabis' },   // 3× → regional chain
    { name: 'Solo Shop', brand: '' },
  ]);
  assert.equal(marked.filter((c) => c.chain).length, 3);
  assert.equal(marked.find((c) => c.name === 'Solo Shop').chain, false);
});

test('parseOverpassElements flags big chains on the candidates', () => {
  const rows = parseOverpassElements({
    elements: [
      { type: 'node', id: 1, tags: { name: 'Curaleaf Edgewater', shop: 'cannabis', brand: 'Curaleaf' } },
      { type: 'node', id: 2, tags: { name: 'Green Leaf', shop: 'cannabis' } },
    ],
  });
  assert.equal(rows.find((r) => r.name === 'Curaleaf Edgewater').chain, true);
  assert.equal(rows.find((r) => r.name === 'Green Leaf').chain, false);
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

// ── Apollo-grade email finding: de-obfuscation ───────────────────────────────
test('decodeCfemail XOR-decodes a Cloudflare-protected address', () => {
  // "hi@x.com" encoded with key 0x2a: [2a] then each char ^ 0x2a, hex.
  const key = 0x2a;
  const plain = 'hi@x.com';
  let hex = key.toString(16).padStart(2, '0');
  for (const ch of plain) hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0');
  assert.equal(decodeCfemail(hex), plain);
  assert.equal(decodeCfemail('zz'), '');       // non-hex → ''
  assert.equal(decodeCfemail(''), '');
});

test('decodeEntities turns HTML-entity @ and . back into a real address', () => {
  assert.equal(decodeEntities('info&#64;shop&#46;com'), 'info@shop.com');
  assert.equal(decodeEntities('info&commat;shop&period;com'), 'info@shop.com');
  assert.equal(decodeEntities('info&#x40;shop&#x2e;com'), 'info@shop.com');
});

test('deobfuscate normalizes [at]/[dot] and the bare "at … dot … tld" shape', () => {
  assert.match(deobfuscate('info [at] shop [dot] com'), /info@shop\.com/);
  assert.match(deobfuscate('sales (at) budz (dot) co'), /sales@budz\.co/);
  assert.match(deobfuscate('hello at greenleaf dot com'), /hello@greenleaf\.com/);
  // normal prose is NOT mangled into an email
  assert.doesNotMatch(deobfuscate('meet us at the shop'), /@/);
});

test('extractEmails recovers Cloudflare + entity + [at]/[dot] obfuscated emails', () => {
  const key = 0x1b; const plain = 'team@budz.co';
  let hex = key.toString(16).padStart(2, '0');
  for (const ch of plain) hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0');
  const html = `
    <a class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</a>
    <p>Wholesale: sales&#64;budz&#46;com</p>
    <p>Or reach us: info [at] budz [dot] com</p>`;
  const found = extractEmails(html);
  assert.ok(found.includes('team@budz.co'), `cfemail — got ${found}`);
  assert.ok(found.includes('sales@budz.com'), `entity — got ${found}`);
  assert.ok(found.includes('info@budz.com'), `[at]/[dot] — got ${found}`);
});

test('rankContactLinks ranks wholesale/contact/team pages, ignores off-site', () => {
  const html = `
    <a href="/wholesale">Wholesale</a>
    <a href="/our-team">Team</a>
    <a href="/contact-us">Contact</a>
    <a href="/blog/2024/some-post">Blog</a>
    <a href="https://facebook.com/contact">FB</a>`;
  const links = rankContactLinks(html, 'https://budz.com', 4);
  assert.equal(links[0], 'https://budz.com/wholesale');   // highest weight first
  assert.ok(links.includes('https://budz.com/contact-us'));
  assert.ok(links.every((u) => u.startsWith('https://budz.com')));  // same-site only
  assert.ok(!links.some((u) => u.includes('/blog/')));    // non-keyword page skipped
});

// ── Apollo-grade verification: DNS-cache safety + disposable filter ───────────
test('isTransientDnsError distinguishes temp failures from a definitive no-domain', () => {
  assert.equal(isTransientDnsError({ code: 'ETIMEOUT' }), true);
  assert.equal(isTransientDnsError({ code: 'ESERVFAIL' }), true);
  assert.equal(isTransientDnsError({ code: 'EAI_AGAIN' }), true);
  assert.equal(isTransientDnsError({ message: 'dns-timeout' }), true);
  assert.equal(isTransientDnsError({ code: 'ENOTFOUND' }), false); // NXDOMAIN = definitive
  assert.equal(isTransientDnsError({ code: 'ENODATA' }), false);
});

test('isDisposableDomain flags throwaway inboxes', () => {
  assert.equal(isDisposableDomain('mailinator.com'), true);
  assert.equal(isDisposableDomain('YOPMAIL.com'), true);
  assert.equal(isDisposableDomain('greenleaf.com'), false);
});

test('partitionDeliverable rejects disposable domains even with valid MX', () => {
  const mx = new Map([['budz.com', true], ['mailinator.com', true]]);
  const { good, bad } = partitionDeliverable(
    [{ email: 'info@budz.com' }, { email: 'x@mailinator.com' }], mx,
  );
  assert.deepEqual(good.map((c) => c.email), ['info@budz.com']);
  assert.deepEqual(bad.map((c) => c.email), ['x@mailinator.com']);
});
