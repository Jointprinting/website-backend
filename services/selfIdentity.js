// services/selfIdentity.js
//
// "Who is US?" — the one place that knows Joint Printing's own identity, so the
// receipt scanner never stamps the company itself as the counter-party on a
// transaction. The motivating bug: Nate uploaded one of HIS OWN client invoices
// (letterhead "Joint Printing", a $1,537.16 payment he received) and the reader
// read the seller off the letterhead and set party = "Joint Printing LLC". For an
// income / customer sale the party must be the CLIENT who paid — never us.
//
// This is deliberately a tiny, extensible constant + a normalizer. Add a new
// trading name, a domain, or the owner's email here and every surface that calls
// isSelf() picks it up. Env-overridable (SELF_NAMES, SELF_DOMAINS) so a deploy can
// extend the list without a code change.

// Names Joint Printing trades under (what shows on its own letterhead/invoices).
// Matched fuzzily by selfKey() (lowercased, punctuation + a trailing corp suffix
// stripped), so "Joint Printing", "Joint Printing LLC", and "JOINT PRINTING, INC."
// all collapse to the same key.
const SELF_NAMES = [
  'Joint Printing',
  'Joint Printing LLC',
  'JointPrinting',
  ...String(process.env.SELF_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean),
];

// Web/email domains that mean "us". A party that is really an email or a URL
// (a misread that grabbed "billing@jointprinting.com" or "jointprinting.com" off
// the footer) still resolves to self via the domain check below.
const SELF_DOMAINS = [
  'jointprinting.com',
  ...String(process.env.SELF_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
];

// Trailing corporate suffixes stripped from the IDENTITY key only (not the
// displayed name) — mirrors utils/fieldTrackerImport.js CORP_SUFFIXES so "us with
// a suffix" and "us without one" match the same way the CRM dedupe does. Stripped
// at the END only, so a name like "Incognito" keeps its "inc".
const CORP_SUFFIXES = ['incorporated', 'corporation', 'company', 'limited',
  'inc', 'llc', 'l.l.c', 'co', 'corp', 'ltd', 'lp', 'llp', 'plc'];

// Pull the registrable domain out of a string that may be an email, a URL, or a
// bare host. Returns '' when there's no domain-looking token. Lowercased.
function domainOf(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at >= 0) return s.slice(at + 1).replace(/[/].*$/, '').replace(/[^a-z0-9.-]/g, '');
  const m = s.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
  return m ? m[1] : '';
}

// Identity key for a name: lowercase, drop apostrophes, strip ONE trailing corp
// suffix, then remove every remaining non-alphanumeric. '' when nothing is left
// (so an empty/punctuation-only name never accidentally equals a self key).
function selfKey(name) {
  let raw = String(name == null ? '' : name).toLowerCase();
  raw = raw.replace(/['’`]/g, '');
  for (const suf of CORP_SUFFIXES) {
    const re = new RegExp(`[\\s,.&-]+${suf.replace(/\./g, '\\.')}\\.?$`, 'i');
    if (re.test(raw)) { raw = raw.replace(re, ''); break; }
  }
  return raw.replace(/[^a-z0-9]+/g, '');
}

// Precompute the self name keys once.
const SELF_KEYS = new Set(SELF_NAMES.map(selfKey).filter(Boolean));
const SELF_DOMAIN_SET = new Set(SELF_DOMAINS.filter(Boolean));

// Is this name/email/domain Joint Printing itself? True when its identity key is
// one of our known names OR its domain is one of ours. Conservative: a blank or
// unrecognized value is NOT self (so an unknown counter-party is treated as the
// real other party, never mistaken for us).
function isSelf(value) {
  if (value == null) return false;
  const key = selfKey(value);
  if (key && SELF_KEYS.has(key)) return true;
  const dom = domainOf(value);
  if (dom && SELF_DOMAIN_SET.has(dom)) return true;
  return false;
}

// From a list of candidate names, the FIRST that is a real other party — non-blank
// and not us. Used to pick the client off a JP invoice that names both the seller
// (us) and the bill-to (them). Returns '' when none qualifies (caller leaves the
// party blank for the owner to fill rather than guessing).
function firstNonSelf(...candidates) {
  for (const c of candidates) {
    const s = String(c == null ? '' : c).trim();
    if (s && !isSelf(s)) return s;
  }
  return '';
}

module.exports = {
  SELF_NAMES, SELF_DOMAINS, CORP_SUFFIXES,
  isSelf, selfKey, domainOf, firstNonSelf,
};
