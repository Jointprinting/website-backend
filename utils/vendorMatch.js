// utils/vendorMatch.js
//
// Vendor (printer/supplier) IDENTITY + the conservative "same printer" test that
// powers the dedup/merge tooling and PO-vendor canonicalization. Pure (no DB, no
// Mongoose) so it is unit-testable and shared by the controller + the seeders.
//
// THREE keys, on purpose — mirrors the CRM dedup design (utils/fieldTrackerImport
// matchKey vs companyKey), tuned for vendors:
//
//   • vendorKey   — the EXISTING numbering/grouping slug (utils/poCost.vendorKey:
//                   trim + collapse whitespace + lowercase). Re-exported here so
//                   callers have one import. It is the canonical key a PO is
//                   GROUPED and NUMBERED on — never loosened.
//   • vendorMatchKey — a fuzzier IDENTITY-ish key used ONLY by the duplicate
//                   finder / merge tooling. It lowercases, drops apostrophes +
//                   punctuation, and strips ONE trailing corporate suffix
//                   (inc/llc/co/printing/screen printing/…), so "Heritage Inc",
//                   "Heritage, Inc." and "Heritage Screen Printing" collapse to
//                   the same stem "heritage". Suggestions only — merging stays an
//                   explicit, reversible owner action.
//   • the fuzzy   `sameVendor` predicate — catches the real owner case where the
//                   matchKeys DON'T collapse but one name is clearly the other:
//                   one stem is a prefix/sub-token-sequence of the other, or they
//                   share strong token overlap (Jaccard). Deliberately CONSERVATIVE
//                   (a shared first token alone is NOT enough — "Heritage" matches
//                   "Heritage Screen Printing" but NOT "Heritage Sportswear" unless
//                   the overlap is strong) so we never propose-merge two genuinely
//                   different printers.

const { vendorKey } = require('./poCost');

// Suffixes stripped from the MATCH key (never from the canonical vendorKey).
// DELIBERATELY NARROW. Two kinds only:
//   • generic CORPORATE suffixes (inc/llc/co/corp/ltd/…) — pure entity-type noise;
//   • the generic "(screen) printing/print(s)" trade tail — because the owner's
//     real case is a SHORT name ("Heritage") vs the full trade name ("Heritage
//     Screen Printing"), so stripping that tail makes both reduce to the same stem.
// We do NOT strip DISTINGUISHING trade words ("sportswear", "apparel", "graphics",
// "embroidery", "promo"…): those are part of a real, separating name — stripping
// them would wrongly collapse "Heritage Sportswear" into "Heritage Screen Printing".
// ("Heritage Screen Printing" ≈ "Heritage Printing" still groups, via the strong
// token-overlap rule in sameVendor — it does not need a matchKey collapse.)
// Matched word-bounded at the END only, so "Incognito" keeps its "inc" and
// "Printing Plus" keeps "printing".
const VENDOR_SUFFIXES = [
  // multi-word first (longest match wins)
  'screen printing', 'screen prints', 'screen print',
  'print shop', 'printing co', 'printing company',
  // single word — generic trade tail
  'printing', 'prints', 'print', 'screenprinting', 'screenprint',
  // single word — generic corporate entity types
  'incorporated', 'corporation', 'company', 'limited',
  'inc', 'llc', 'l.l.c', 'co', 'corp', 'ltd', 'lp', 'llp', 'plc',
];

// Lowercase, drop apostrophes (so "joe's" == "joes"), then strip a SINGLE trailing
// corporate/trade suffix, then remove all remaining non-alphanumerics. Used ONLY
// to propose duplicate groups — never to decide a PO's number/grouping. Returns ''
// when nothing is left (caller treats that as "no match key").
function vendorMatchKey(name) {
  let raw = String(name == null ? '' : name).toLowerCase();
  raw = raw.replace(/['’`]/g, '');                    // apostrophes vanish, not split
  // Strip ONE trailing suffix (optionally preceded by space/punctuation). Longest
  // suffix first (the list is ordered) so "screen printing" wins over "printing".
  for (const suf of VENDOR_SUFFIXES) {
    const re = new RegExp(`[\\s,.&-]+${suf.replace(/\./g, '\\.')}\\.?$`, 'i');
    if (re.test(raw)) { raw = raw.replace(re, ''); break; }
  }
  return raw.replace(/[^a-z0-9]+/g, '');
}

// Tokenize a vendor name into lowercased word tokens with apostrophes folded and
// punctuation dropped. Trade-suffix words are KEPT here (the token comparison is
// what decides overlap); only empty tokens are removed.
function vendorTokens(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Is token array `a` an in-order prefix of `b`? ("heritage" ⊂ "heritage screen
// printing"; "heritage screen" ⊂ "heritage screen printing"). Order matters so
// "screen heritage" is NOT a prefix of "heritage screen printing".
function isTokenPrefix(a, b) {
  if (a.length === 0 || a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Jaccard overlap of two token SETS (|A∩B| / |A∪B|). 0..1.
function tokenJaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// The conservative "same printer" predicate. TRUE when two free-text vendor names
// almost certainly refer to the same supplier:
//   1) identical canonical vendorKey (case/whitespace only) — trivially same; OR
//   2) identical fuzzy vendorMatchKey (corp/trade suffix stripped) — "Heritage
//      Inc" ≈ "Heritage Screen Printing"; OR
//   3) one name's token sequence is an in-order PREFIX of the other AND the
//      shorter has a meaningful stem (≥ 4 chars, to avoid "A"/"AB" coincidences)
//      — "Heritage" ⊂ "Heritage Screen Printing"; OR
//   4) strong token-set overlap (Jaccard ≥ 0.6) — handles re-orderings / a shared
//      multi-word core ("Heritage Screen Printing" vs "Heritage Printing").
// Returns FALSE for genuinely different printers that merely share ONE generic
// token ("Heritage Screen Printing" vs "Heritage Sportswear" — different stems,
// prefix is only the 1 generic token, Jaccard 0.25). Empty/whitespace names never
// match anything (so "Unassigned"/'' can't swallow a real vendor).
function sameVendor(nameA, nameB) {
  const ka = vendorKey(nameA);
  const kb = vendorKey(nameB);
  if (!ka || !kb) return false;
  if (ka === kb) return true;

  // (2) Equal fuzzy match key (corp/trade suffix stripped). Require a stem of ≥ 3
  //     chars so a coincidental 1-2 char collision after stripping ("A&B Printing"
  //     vs "A B Printing" → "ab") does NOT auto-propose a merge — short stems are
  //     the danger zone for false positives.
  const ma = vendorMatchKey(nameA);
  const mb = vendorMatchKey(nameB);
  if (ma && mb && ma === mb && ma.length >= 3) return true;

  const ta = vendorTokens(nameA);
  const tb = vendorTokens(nameB);
  if (ta.length === 0 || tb.length === 0) return false;

  // (3) In-order prefix, with a meaningful shorter stem so a 1-3 char coincidence
  //     can't trigger. The shorter side's first token must be ≥ 4 chars (a real
  //     name like "Heritage", not "A&"/"AB").
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer = ta.length <= tb.length ? tb : ta;
  if (shorter[0] && shorter[0].length >= 4 && isTokenPrefix(shorter, longer)) return true;

  // (4) Strong token-set overlap. 0.6 keeps a single shared generic token (0.25–0.33
  //     for typical lengths) from qualifying, while a shared multi-word core does.
  if (tokenJaccard(ta, tb) >= 0.6) return true;

  return false;
}

// A blank / "Unassigned" sentinel that must never anchor a real vendor identity.
const UNASSIGNED_KEY = 'unassigned';
function isRealVendorName(name) {
  const k = vendorKey(name);
  return !!k && k !== UNASSIGNED_KEY;
}

// Group an array of vendor docs into likely-duplicate clusters. A cluster is a set
// of 2+ vendors that are pairwise-connected by sameVendor (transitive closure via
// union-find), so "Heritage" + "Heritage Inc" + "Heritage Screen Printing" all
// land in ONE group. Returns an array of arrays (each inner array is the member
// docs); singletons are omitted. Order within a group preserves input order.
//
// `nameOf(doc)` extracts the comparable name (defaults to doc.name).
function groupVendorDuplicates(vendors, nameOf = (v) => v && v.name) {
  const arr = (Array.isArray(vendors) ? vendors : []).filter((v) => v && isRealVendorName(nameOf(v)));
  const n = arr.length;
  const parent = arr.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const ri = find(i); const rj = find(j); if (ri !== rj) parent[ri] = rj; };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sameVendor(nameOf(arr[i]), nameOf(arr[j]))) union(i, j);
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(arr[i]);
  }
  return [...byRoot.values()].filter((g) => g.length > 1);
}

// "How complete is this vendor record" score, used to pick the survivor of a
// duplicate group — prefer the one WITH details / most POs / most spend (mirrors
// CRM pickSurvivor). Higher is better. Pure: reads counts the caller attaches
// (poCount / spend / orderCount) plus the profile fields on the doc itself.
function vendorRecordScore(v, stats = {}) {
  const filled = ['contactName', 'email', 'phone', 'address', 'shipMethod', 'accountNumber', 'notes']
    .reduce((s, f) => s + (String((v && v[f]) || '').trim() ? 1 : 0), 0);
  return [
    Number(stats.poCount) || 0,                              // most POs (real usage)
    Math.round((Number(stats.spend) || 0) * 100) / 100,      // most actual spend
    Number(stats.orderCount) || 0,                           // most connected orders
    filled,                                                  // richest profile
    (v && Array.isArray(v.vendorOrders) ? v.vendorOrders.length : 0), // learned links
    -new Date((v && v.createdAt) || 0).getTime() / 1e13,     // older wins as a tiebreak
  ];
}

// Pick the survivor doc from a group. `statsOf(doc)` → { poCount, spend, orderCount }
// (defaults to whatever counts are already on the doc). Returns the chosen doc.
function pickVendorSurvivor(group, statsOf = (v) => v) {
  const arr = Array.isArray(group) ? group.filter(Boolean) : [];
  if (arr.length === 0) return null;
  let best = arr[0];
  let bestScore = vendorRecordScore(best, statsOf(best));
  for (const v of arr.slice(1)) {
    const sc = vendorRecordScore(v, statsOf(v));
    for (let i = 0; i < sc.length; i++) {
      if (sc[i] > bestScore[i]) { best = v; bestScore = sc; break; }
      if (sc[i] < bestScore[i]) break;
    }
  }
  return best;
}

// Pure survivor-folding policy for a vendor merge: mutate `survivor` in place,
// pulling everything worth keeping out of `merged` WITHOUT losing data (mirrors
// CRM foldMergeFields). Profile blanks fill from the merged record (never
// clobber); notes concatenate; the learned vendor↔order links union (one entry
// per canonical order #, newest `at` wins); nextPoStart keeps the larger floor;
// blanksProvided keeps the survivor's unless it is unset (defaulted true) and the
// merged one explicitly set false. Order-number normalization is injected
// (`normOrderNum`) so this stays DB-free. Returns the mutated survivor.
function foldVendorFields(survivor, merged, normOrderNum = (x) => String(x || '')) {
  // Scalars: fill the survivor's blanks from the merged record.
  for (const f of ['contactName', 'email', 'phone', 'address', 'shipMethod', 'accountNumber']) {
    if (!String(survivor[f] || '').trim() && String(merged[f] || '').trim()) survivor[f] = merged[f];
  }
  // Notes: keep both.
  if (String(merged.notes || '').trim()) {
    survivor.notes = [survivor.notes, merged.notes].filter((x) => String(x || '').trim()).join('\n---\n');
  }
  // Next-PO floor: keep the higher owner-set start so neither vendor's real run
  // can collide after the merge.
  survivor.nextPoStart = Math.max(Number(survivor.nextPoStart) || 0, Number(merged.nextPoStart) || 0);

  // Learned vendor↔order links: union by canonical order number, newest `at` wins.
  const links = new Map();
  const add = (l) => {
    const key = normOrderNum(l && l.orderNumber);
    if (!key) return;
    const at = l && l.at ? new Date(l.at) : new Date(0);
    const cur = links.get(key);
    if (!cur || at > new Date(cur.at || 0)) links.set(key, { orderNumber: key, at });
  };
  (Array.isArray(survivor.vendorOrders) ? survivor.vendorOrders : []).forEach(add);
  (Array.isArray(merged.vendorOrders) ? merged.vendorOrders : []).forEach(add);
  survivor.vendorOrders = [...links.values()].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

  return survivor;
}

// PURE vendor-name resolution (no DB) — the decision the PO controller makes when
// canonicalizing a typed vendor name against the existing contact book. Mirrors
// _resolveCanonicalVendor's three tiers and is AMBIGUITY-SAFE: returns the single
// matching vendor, or null when there's no match OR more than one distinct vendor
// matches (never guesses). `vendors` is the candidate list (already excludes
// archived). Exported so canonicalization is unit-testable without Mongo.
function resolveVendorFromList(name, vendors) {
  const raw = String(name || '').trim();
  if (!isRealVendorName(raw)) return null;
  const all = (Array.isArray(vendors) ? vendors : []).filter((v) => v && isRealVendorName(v.name));

  // Tier 1: exact case-insensitive name — unambiguous fast path, always wins.
  const rawKey = vendorKey(raw);
  const exact = all.find((v) => vendorKey(v.name) === rawKey);
  if (exact) return exact;

  // Tiers 2+3 assessed TOGETHER so ambiguity across them can't slip through: a
  // vendor is a candidate if its fuzzy matchKey equals the typed stem OR it passes
  // the conservative same-printer test. Resolve ONLY when the union is exactly one
  // distinct vendor; >1 distinct candidate → don't guess (return null). (The
  // matchKey tier alone could see one match while the fuzzy tier sees two — e.g.
  // typed "Heritage" vs existing "Heritage Screen Printing" + "Heritage Apparel" —
  // so they must be unioned, not checked sequentially.)
  const mk = vendorMatchKey(raw);
  const byKey = new Map();
  for (const v of all) {
    if (vendorKey(v.name) === rawKey) continue;   // same as typed (no exact existed)
    if ((mk && vendorMatchKey(v.name) === mk) || sameVendor(raw, v.name)) {
      byKey.set(vendorKey(v.name), v);
    }
  }
  if (byKey.size === 1) return [...byKey.values()][0];
  return null;   // none, or ambiguous → keep the typed name
}

module.exports = {
  vendorKey,
  vendorMatchKey,
  vendorTokens,
  sameVendor,
  isRealVendorName,
  groupVendorDuplicates,
  vendorRecordScore,
  pickVendorSurvivor,
  foldVendorFields,
  resolveVendorFromList,
  // exported for unit tests
  isTokenPrefix,
  tokenJaccard,
  VENDOR_SUFFIXES,
};
