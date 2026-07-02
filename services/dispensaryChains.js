// services/dispensaryChains.js
//
// Chain (multi-store brand) detection for dispensaries — two complementary
// passes:
//
//   1. KNOWN_CHAINS regex list — national + regional MSO brands we can name.
//      Superset of the old controllers/placeSearch.js east-coast list, which
//      now delegates here so live Google results and roster ingests agree.
//
//   2. Name-family grouping — normalize each store's display name down to a
//      "brand base" (corp suffixes, state names, "of <city>" tails stripped)
//      and call any base with ≥ CHAIN_MIN_LOCATIONS stores a chain. Catches
//      brands the hand list doesn't know yet; the canonical label is the
//      most common original spelling in the family.
//
// False negatives are fine (an unmatched store shows as a one-off — the safe
// default). First regex match wins; broader patterns last.

const CHAIN_MIN_LOCATIONS = 3;

const KNOWN_CHAINS = [
  // National / multi-state operators
  [/curaleaf/i, 'Curaleaf'],
  [/trulieve/i, 'Trulieve'],
  [/\brise\s+(medical|adult|dispens|cannabis|recreational|marijuana)/i, 'RISE (GTI)'],
  [/sunnyside/i, 'Sunnyside (Cresco)'],
  [/verilife|pharmacann/i, 'Verilife (PharmaCann)'],
  [/cannabist|columbia\s+care/i, 'Cannabist (Columbia Care)'],
  [/ayr\s*wellness|\bayr\b\s+(medical|cannabis|dispens|recreational|marijuana)/i, 'AYR Wellness'],
  [/beyond[\s/-]*hello|\bjushi\b/i, 'Beyond/Hello (Jushi)'],
  [/ascend\s+(wellness|dispens|medical|cannabis|recreational|marijuana)/i, 'Ascend'],
  [/the\s+botanist|acreage/i, 'The Botanist (Acreage)'],
  [/apothecarium|terrascend|\bgage\b/i, 'TerrAscend (Apothecarium/Gage)'],
  [/zen\s+leaf|verano|\bmüv\b|\bmuv\b/i, 'Zen Leaf (Verano)'],
  [/\bmedmen\b/i, 'MedMen'],
  [/cookies\s+(retail|dispens|cannabis|on\b)/i, 'Cookies'],
  [/\bstiiizy\b/i, 'STIIIZY'],
  [/green\s+thumb\s+industries|\bGTI\b/, 'Green Thumb Industries'],
  [/cresco\s+labs?/i, 'Cresco Labs'],
  [/liberty\s+health\s+sciences|\bLHS\b/, 'Liberty Health Sciences'],
  [/harvest\s+(of|hoc|dispens|cannabis|medical|marijuana)/i, 'Harvest'],
  // Northeast
  [/theory\s+wellness/i, 'Theory Wellness'],
  [/\bneta\b/i, 'NETA'],
  [/\binsa\b/i, 'Insa'],
  [/\betain\b/i, 'Etain'],
  [/fine\s+fettle/i, 'Fine Fettle'],
  [/nova\s+farms/i, 'Nova Farms'],
  [/mission\s+(dispens|cannabis)/i, 'Mission'],
  [/silver\s+therapeutics/i, 'Silver Therapeutics'],
  [/berkshire\s+roots/i, 'Berkshire Roots'],
  [/\bethos\b/i, 'Ethos'],
  [/housing\s*works\s*cannabis/i, 'Housing Works'],
  // Midwest
  [/\blume\b/i, 'Lume'],
  [/\bjars\b/i, 'JARS'],
  [/skymint/i, 'Skymint'],
  [/cloud\s+cannabis/i, 'Cloud Cannabis'],
  [/\bpuff\b\s*(cannabis|dispens)/i, 'Puff Cannabis'],
  [/consume\s+cannabis/i, 'Consume'],
  [/\bsociable\b|\bsunny\s*side\b/i, 'Sunnyside (Cresco)'],
  // West
  [/native\s+roots/i, 'Native Roots'],
  [/green\s+dragon/i, 'Green Dragon'],
  [/\bstarbuds\b/i, 'Star Buds'],
  [/lightshade/i, 'Lightshade'],
  [/the\s+green\s+solution|\btgs\b/i, 'The Green Solution'],
  [/\bterrapin\b/i, 'Terrapin Care Station'],
  [/livwell/i, 'LivWell'],
  [/\bnectar\b/i, 'Nectar'],
  [/la\s+mota/i, 'La Mota'],
  [/\bchalice\b/i, 'Chalice Farms'],
  [/\bzips\b/i, 'Zips Cannabis'],
  [/uncle\s+ike/i, "Uncle Ike's"],
  [/hashtag\s+cannabis/i, 'Hashtag'],
  [/\bdockside\b/i, 'Dockside'],
  [/the\s+mint\s+(dispens|cannabis)/i, 'The Mint'],
  [/\bcuraleaf\b/i, 'Curaleaf'],
];

function detectKnownChain(name = '') {
  for (const [rx, label] of KNOWN_CHAINS) {
    if (rx.test(name)) return label;
  }
  return null;
}

// ── Name-family grouping ─────────────────────────────────────────────────────

const US_STATE_WORDS = [
  'alaska', 'arizona', 'california', 'colorado', 'connecticut', 'delaware',
  'illinois', 'massachusetts', 'maryland', 'maine', 'michigan', 'minnesota',
  'missouri', 'montana', 'new jersey', 'new mexico', 'nevada', 'new york',
  'ohio', 'oregon', 'rhode island', 'vermont', 'washington', 'jersey',
];

const NOISE_WORDS = [
  'dispensary', 'dispensaries', 'cannabis', 'marijuana', 'weed', 'recreational',
  'adult use', 'adult-use', 'medical', 'and', 'the',
  'llc', 'l l c', 'inc', 'corp', 'co', 'company', 'ltd', 'holdings', 'group',
];

/**
 * Reduce a store display name to its brand base: lowercase, strip location
 * tails ("Curaleaf Bellmawr", "Ascend - Rochelle Park", "Sunnyside Wynnewood"),
 * corp suffixes, and category noise words. Location tails are handled by
 * cutting at " - ", " of ", " at ", "@" separators and by dropping trailing
 * city-looking tokens only when a separator made that unambiguous.
 */
function brandBase(name = '') {
  let s = String(name).toLowerCase().trim();
  // Cut at explicit location separators: "brand - city", "brand of city",
  // "brand at city", "brand | city", "brand (city)", "brand @ city".
  s = s.split(/\s+[-–|@(]\s*|\s+\bof\b\s+|\s+\bat\b\s+/)[0];
  for (const st of US_STATE_WORDS) s = s.replace(new RegExp(`\\b${st}\\b`, 'g'), ' ');
  for (const w of NOISE_WORDS) s = s.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
  s = s.replace(/['’`.,&]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Given [{name, licensee}] rows, return Map<index, chainLabel> combining the
 * known-brand regexes with ≥ CHAIN_MIN_LOCATIONS name families. The family
 * label is the modal original name's leading words (prettified base).
 */
function assignChains(rows) {
  const out = new Map();
  const families = new Map(); // base -> { idxs: [], labels: Map<label,count> }

  rows.forEach((row, i) => {
    const known = detectKnownChain(row.name || '') || detectKnownChain(row.licensee || '');
    if (known) { out.set(i, known); return; }
    const base = brandBase(row.name || '');
    if (!base || base.length < 3) return;
    if (!families.has(base)) families.set(base, { idxs: [], labels: new Map() });
    const fam = families.get(base);
    fam.idxs.push(i);
    // Pretty label candidate: original name up to the first separator.
    const label = String(row.name || '').split(/\s+[-–|@(]\s*|\s+\bof\b\s+|\s+\bat\b\s+/)[0].trim();
    fam.labels.set(label, (fam.labels.get(label) || 0) + 1);
  });

  for (const fam of families.values()) {
    if (fam.idxs.length < CHAIN_MIN_LOCATIONS) continue;
    let best = ''; let bestN = 0;
    for (const [label, n] of fam.labels) if (n > bestN) { best = label; bestN = n; }
    for (const i of fam.idxs) out.set(i, best);
  }
  return out;
}

module.exports = { KNOWN_CHAINS, detectKnownChain, brandBase, assignChains, CHAIN_MIN_LOCATIONS };
