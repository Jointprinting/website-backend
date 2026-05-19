// services/jpwDedupe.js
//
// Normalization + matching for JPW leads. We want to recognize the same
// business no matter which source it arrived from (Google Places, Apify
// scrape, manual entry, OutScraper CSV) without falsely merging look-alikes.
//
// Match priority, in order — first hit wins:
//   1. Google place_id   (authoritative, exact)
//   2. Normalized phone  (10-digit US, leading +1 stripped)
//   3. Domain            (apex domain, ignore protocol/www/path)
//   4. Normalized name + city  (fuzzy: company suffixes & punctuation stripped)
//
// We never auto-merge on name alone — too many "John's Plumbing" exist across
// states. Name+city is the loosest match we'll accept.

// ── Phone ──────────────────────────────────────────────────────────────────
function normalizePhone(raw = '') {
  if (!raw) return '';
  // Strip everything except digits, then drop a leading 1 (US country code)
  // and discard anything that isn't a 10-digit US number.
  const digits = String(raw).replace(/\D+/g, '');
  const trimmed = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return trimmed.length === 10 ? trimmed : '';
}

// ── Domain ─────────────────────────────────────────────────────────────────
function normalizeDomain(rawUrl = '') {
  if (!rawUrl) return '';
  let s = String(rawUrl).trim().toLowerCase();
  // Add scheme so the URL parser doesn't choke on bare "example.com/foo"
  if (!/^https?:\/\//.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ── Business name ──────────────────────────────────────────────────────────
//
// Strip noise words that don't help disambiguate ("LLC", "Inc", "Co",
// "Company", "The", "&", state suffixes). Leave the meaningful tokens.
const NAME_STOPWORDS = [
  /\bllc\b/g, /\binc\b/g, /\bcorp\b/g, /\bco\b/g, /\bltd\b/g,
  /\bcompany\b/g, /\bthe\b/g, /\band\b/g,
  /\bsouth\s+jersey\b/g, /\bnew\s+jersey\b/g, /\bn\.?j\.?\b/g,
];

function normalizeName(raw = '') {
  if (!raw) return '';
  let s = String(raw).toLowerCase();
  s = s.replace(/['’`.,!?]/g, '');           // punctuation
  s = s.replace(/&/g, ' and ');
  for (const rx of NAME_STOPWORDS) s = s.replace(rx, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function normalizeCity(raw = '') {
  return String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Levenshtein for fuzzy name comparisons — fine for short strings.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// Names match if normalized strings are equal OR within a Levenshtein
// distance that scales with length (≤2 for short names, more lenient for
// longer ones). Tuned to catch "Joe's Plumbing" vs "Joes Plumbing" while
// rejecting "Joe's Plumbing" vs "Joe's Electric".
function namesProbablyMatch(aRaw, bRaw) {
  const a = normalizeName(aRaw);
  const b = normalizeName(bRaw);
  if (!a || !b) return false;
  if (a === b) return true;
  const tolerance = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.15));
  return levenshtein(a, b) <= tolerance;
}

// ── Main matcher ───────────────────────────────────────────────────────────
//
// Given an incoming candidate {name, phone, website, place_id, city}, build
// a Mongo filter that finds an existing lead matching by ANY of the priority
// keys. The caller decides whether to merge (update) or insert.
function buildDedupeFilter({ google_place_id, normalized_phone, domain, normalized_name, normalized_city }) {
  const orClauses = [];
  if (google_place_id)  orClauses.push({ google_place_id });
  if (normalized_phone) orClauses.push({ normalized_phone });
  if (domain)           orClauses.push({ domain });
  if (normalized_name && normalized_city) {
    orClauses.push({ normalized_name, normalized_city });
  }
  return orClauses.length ? { $or: orClauses } : null;
}

// Convenience: pull dedupe keys from a raw input record (whatever shape).
function buildDedupeKeys(input = {}) {
  return {
    google_place_id:  input.google_place_id || input.place_id || '',
    normalized_phone: normalizePhone(input.phone),
    domain:           normalizeDomain(input.website_url || input.website),
    normalized_name:  normalizeName(input.business_name || input.name),
    normalized_city:  normalizeCity(input.city),
  };
}

module.exports = {
  normalizePhone,
  normalizeDomain,
  normalizeName,
  normalizeCity,
  namesProbablyMatch,
  buildDedupeFilter,
  buildDedupeKeys,
  levenshtein,
};
