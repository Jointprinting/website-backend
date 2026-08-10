// utils/emailQuality.js
//
// One home for "is this address worth a cold send?" — used by BOTH the harvester
// (services/emailEnricher.js, which picks an address off a shop's website) and
// the sender (services/outreachEngine.js, which picks one at send time). Those
// two used to rank independently, with the same inverted rule on each side:
//
//     any local-part not in a short role list scored as "a named person"
//
// so `careers@`, `privacy@`, `webmaster@`, `postmaster@` and friends all
// OUTRANKED `info@`. Those mailboxes mostly don't exist, so the engine
// preferentially harvested and mailed the one address on the page most likely to
// bounce — and a bounce on a young sending domain costs far more than the lead
// was worth.
//
// The fix is a three-tier verdict, shared:
//   never   — don't harvest, don't store, never send. Either it cannot exist as a
//             mailbox (postmaster@, noreply@) or nobody behind it can buy merch
//             (careers@, legal@, press@). Both roads end at a wasted send.
//   role    — a shared inbox a small shop genuinely reads. info@ is the front
//             door of most dispensaries; this is a perfectly good cold target.
//   person  — looks like a human's name. The best target, when we can get one.
//   unknown — something else. Sendable, but ranked BELOW a known-good role inbox,
//             because an unrecognized function address is more likely to be a
//             dead alias than a buyer.
//
// Everything here is pure and unit-tested — no DNS, no network. Deliverability
// (does the domain accept mail at all) stays in services/emailVerify.js.

// Never cold-email these. Kept deliberately broad on the "cannot buy" side: the
// cost of skipping a real buyer at legal@ is one lost lead; the cost of sending
// is a bounce that degrades delivery for every other lead on the domain.
const NEVER_LOCALS = new Set([
  // Cannot be a real recipient / infrastructure addresses
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'mailer-daemon', 'mailerdaemon', 'postmaster', 'hostmaster', 'webmaster',
  'root', 'daemon', 'bounce', 'bounces', 'undisclosed-recipients',
  // Automated / list plumbing
  'unsubscribe', 'subscribe', 'newsletter', 'notifications', 'notification',
  'alerts', 'alert', 'automated', 'automation', 'robot', 'bot', 'noc',
  // Abuse / compliance desks — never a buyer, often auto-ticketed
  'abuse', 'spam', 'dmarc', 'dkim', 'spf', 'security', 'privacy', 'legal',
  'dmca', 'compliance', 'copyright',
  // Hiring — a very common scrape hit and never a merch buyer
  'careers', 'career', 'jobs', 'job', 'hiring', 'recruiting', 'recruitment',
  'resumes', 'resume', 'hr', 'humanresources',
  // Press / investor relations
  'press', 'media', 'pr', 'publicity', 'investors', 'investor', 'ir',
  // Finance back-office
  'billing', 'accounting', 'accounts', 'accountspayable', 'accountsreceivable',
  'ap', 'ar', 'payroll', 'invoice', 'invoices', 'collections',
  // Placeholders left in templates
  'test', 'demo', 'sample', 'example', 'placeholder', 'youremail', 'yourname',
]);

// Shared inboxes a small retail shop actually reads, best first. A dispensary
// that publishes info@ wants to be contacted there — this is not a fallback to
// be ashamed of, it is the front door. Ordered by how likely a buying decision
// sits behind it.
const ROLE_LOCALS = [
  'wholesale', 'purchasing', 'buyer', 'merch', 'marketing',   // closest to the buying decision
  'info', 'contact', 'hello', 'hi', 'sales', 'orders', 'order',
  'management', 'manager', 'owner', 'office', 'team', 'store', 'shop',
  'admin', 'general', 'inquiries', 'inquiry', 'mail', 'help', 'support', 'service',
];
const ROLE_SET = new Set(ROLE_LOCALS);

// Function words that show up as local-parts but are not names. Guards
// looksLikePerson from promoting things like `newsletter2024` or `shopnow`.
const NON_NAME_WORDS = /^(shop|store|web|site|online|home|main|new|old|the|and|for|our|your|my|us|we|all|any|get|buy|now|here|click|link|page|form|mail|email|box|inbox|list|group|dept|department|division|branch|location|hours|menu|deals|specials|events|delivery|pickup|curbside|budtender|budtenders)$/i;

// Cannabis-ADJACENT businesses that are not dispensaries and can never buy
// dispensary merch: magazines, directories, delivery marketplaces, seed banks,
// and the CBD/hemp e-commerce shops that a "cannabis" search inevitably drags
// in. They surface constantly in scraping because they rank for every cannabis
// term — and the owner's bounce log is full of them: merry.jane@hightimes.com
// (a magazine) and cbd@cbdandoils.com both went out and bounced.
//
// Same reasoning as the never-send LOCALS above: the cost of skipping a real
// buyer here is one lost lead; the cost of sending is a bounce that degrades
// delivery for every other lead on the domain, plus a pitch that was never
// going to land. Suffix-matched on the dot boundary.
const NEVER_DOMAINS = [
  // Media / publishers
  'hightimes.com', 'merryjane.com', 'leafly.com', 'weedmaps.com', 'cannabisnow.com',
  'mgretailer.com', 'mjbizdaily.com', 'ganjapreneur.com', 'thecannabist.co',
  'civilized.life', 'hemp.com', 'marijuanamoment.net', 'benzinga.com',
  // Directories / marketplaces / tech platforms (they sell TO dispensaries)
  'dutchie.com', 'iheartjane.com', 'springbig.com', 'blaze.me', 'meadow.com',
  'greenbits.com', 'flowhub.com', 'treez.io', 'alpineiq.com', 'leaflink.com',
  // Seed banks / grow supply / lab — not retail merch buyers
  'seedsman.com', 'ilgm.com', 'growersnetwork.org',
];
function isNeverDomain(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return false;
  return NEVER_DOMAINS.some((n) => d === n || d.endsWith(`.${n}`));
}

const RE_EMAIL = /^([a-z0-9._%+\-]+)@([a-z0-9.\-]+\.[a-z]{2,})$/;

/** Normalize + split an address. Returns { local, domain } or null. Pure. */
function parseEmail(email) {
  const m = String(email == null ? '' : email).trim().toLowerCase().match(RE_EMAIL);
  return m ? { local: m[1], domain: m[2] } : null;
}

const localOf = (email) => (parseEmail(email) || {}).local || '';
const domainOf = (email) => (parseEmail(email) || {}).domain || '';

// A local-part's "head" — the part before the first separator or plus-tag, so
// `sales.team`, `info+nj` and `careers-us` classify like `sales` / `info` /
// `careers`. Trailing digits are dropped too (`info2`, `noreply01`).
function localHead(local) {
  return String(local || '')
    .split('+')[0]
    .split(/[._-]/)[0]
    .replace(/\d+$/, '');
}

/** Never harvest, never store, never send. Pure. */
function isNeverSend(email) {
  const p = parseEmail(email);
  if (!p) return true;                                  // unparseable is never sendable
  if (isNeverDomain(p.domain)) return true;        // a magazine cannot buy merch
  if (NEVER_LOCALS.has(p.local)) return true;
  if (NEVER_LOCALS.has(localHead(p.local))) return true;
  // Hex-blob / tracking-hash locals are machine addresses, not inboxes.
  if (/^[0-9a-f]{16,}$/.test(p.local)) return true;
  return false;
}

/** A shared-but-real inbox we're happy to cold-email. Pure. */
function isRoleInbox(email) {
  const p = parseEmail(email);
  if (!p) return false;
  return ROLE_SET.has(p.local) || ROLE_SET.has(localHead(p.local));
}

// Does this local-part look like a human's name? Deliberately conservative —
// a false "person" here outranks a good role inbox, which is the exact mistake
// this module exists to prevent.
function nameShaped(local) {
  const l = String(local || '').toLowerCase().split('+')[0];
  if (!l || l.length < 2 || l.length > 32) return false;
  if (NEVER_LOCALS.has(l) || ROLE_SET.has(l)) return false;
  if (!/^[a-z][a-z0-9._-]*$/.test(l)) return false;
  if (/\d{3,}/.test(l)) return false;                   // order12345@ is not a person
  const parts = l.split(/[._-]/).filter(Boolean);
  if (!parts.length || parts.length > 3) return false;
  for (const part of parts) {
    if (!/^[a-z][a-z]*\d{0,2}$/.test(part)) return false;
    if (NON_NAME_WORDS.test(part)) return false;
    if (NEVER_LOCALS.has(part) || ROLE_SET.has(part)) return false;
  }
  return true;
}

// Could this local-part BE a person's, structurally? `jane` and `jane.doe` both
// pass; `xq7zplt` and `order12345` don't. On its own this is not enough to call
// something a person (see below) — but it's the guard that stops a contact name
// promoting a random alias blob.
function looksLikePerson(local) {
  if (!nameShaped(local)) return false;
  const parts = String(local || '').toLowerCase().split('+')[0].split(/[._-]/).filter(Boolean);
  // A MULTI-PART local-part is the only strong evidence of a human: jane.doe,
  // j.doe, jane_doe. Nobody names a functional mailbox that way.
  //
  // A SINGLE unrecognized word is not. It used to count as a person — the top
  // tier, 40 points, above a published info@ — which is how the engine came to
  // prefer feedback@ and cbd@ over the real contact address and then hard-bounce
  // on them, because "feedback" and "cbd" are simply words nobody had blacklisted
  // yet. No blacklist finishes that job; the inference was wrong.
  //
  // Demoting the single-word case to 'unknown' also happens to be the better
  // deliverability bet in its own right. A lone first name is often a former
  // employee whose mailbox was deleted when they left — exactly the stale address
  // that hard-bounces — while a shop's published info@ outlives its staff.
  return parts.length > 1;
}

// Does a CONTACT NAME we hold read as a human being?
//
// This is evidence the local-part can never give us: "jane@" and "feedback@"
// are the same shape, but a record that says the contact is named Jane Rivera
// settles it. Departments are excluded — plenty of CRM rows are named "Front
// Desk" or "Sales Team", which are not people. Pure.
const DEPARTMENT_NAME = /^(front ?desk|reception|sales|info|office|admin|support|help|service|team|staff|management|store|shop|owner|manager|buyer|purchasing|wholesale|marketing|orders?|billing|accounts?|hr|contact)\b/i;
function looksLikeHumanName(name) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 60) return false;
  if (!/[a-z]/i.test(n)) return false;
  if (DEPARTMENT_NAME.test(n)) return false;
  return /^[a-z][a-z'’.-]*(\s+[a-z][a-z'’.-]*){0,3}$/i.test(n);
}

/** 'never' | 'person' | 'role' | 'unknown'. Pure. */
function emailTier(email) {
  if (isNeverSend(email)) return 'never';
  if (isRoleInbox(email)) return 'role';
  if (looksLikePerson(localOf(email))) return 'person';
  return 'unknown';
}

const TIER_SCORE = { person: 40, role: 25, unknown: 10, never: -1000 };

/**
 * Rank one address for cold outreach. Higher is better; a negative score means
 * "never send". `siteHost` is the shop's own domain — an address on it is worth
 * far more than one on a builder/agency domain, which usually isn't the shop.
 * Pure.
 */
function scoreEmail(email, { siteHost = '' } = {}) {
  const p = parseEmail(email);
  if (!p) return TIER_SCORE.never;
  const tier = emailTier(email);
  if (tier === 'never') return TIER_SCORE.never;
  const host = String(siteHost || '').toLowerCase().replace(/^www\./, '');
  const onDomain = !!host && (p.domain === host || p.domain.endsWith(`.${host}`));
  let s = TIER_SCORE[tier];
  if (onDomain) s += 100;
  // Role inboxes keep their internal order (wholesale@ over support@).
  if (tier === 'role') {
    const idx = ROLE_LOCALS.indexOf(ROLE_SET.has(p.local) ? p.local : localHead(p.local));
    if (idx >= 0) s += (ROLE_LOCALS.length - idx) / 100;
  }
  return s;
}

/**
 * Best address out of a list, or '' when every candidate is unsendable.
 * Never returns a `never` address — that is the point. Pure.
 */
function bestEmail(emails, { siteHost = '' } = {}) {
  const list = (Array.isArray(emails) ? emails : [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => e && !isNeverSend(e));
  if (!list.length) return '';
  return list
    .map((e) => ({ e, s: scoreEmail(e, { siteHost }) }))
    .sort((a, b) => b.s - a.s)[0].e;
}

module.exports = {
  looksLikeHumanName,
  isNeverDomain,
  NEVER_DOMAINS,
  nameShaped,
  parseEmail, localOf, domainOf, localHead,
  isNeverSend, isRoleInbox, looksLikePerson,
  emailTier, scoreEmail, bestEmail,
  NEVER_LOCALS, ROLE_LOCALS,
};
