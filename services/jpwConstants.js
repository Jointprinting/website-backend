// services/jpwConstants.js
//
// Reference data for the JP Webworks lead recon engine:
//   - Target South Jersey geography (towns + counties)
//   - Service categories (with tier — high-ticket / mid / low / disqualify)
//   - Scoring weights (mirror of the GPT spec, kept here so the formula has
//     a single source of truth that both the scoring engine and the UI read)
//
// Expanding to new states later means adding entries here, not touching the
// scoring or dedupe code.

const SOUTH_JERSEY_TOWNS = [
  'Voorhees', 'Marlton', 'Cherry Hill', 'Mount Laurel', 'Medford',
  'Berlin', 'Hammonton', 'Williamstown', 'Glassboro', 'Deptford',
  'Sewell', 'Washington Township', 'Gloucester Township', 'Haddonfield',
  'Moorestown', 'Evesham',
];

const SOUTH_JERSEY_COUNTIES = [
  'Burlington', 'Camden', 'Gloucester', 'Atlantic',
  'Cumberland', 'Salem', 'Cape May',
];

// Geographic anchors used to restrict Google Places Text Search to the area
// we actually sell into. Without this, a query like "tree service near
// Voorhees NJ" can leak results from Worcestershire UK or Philadelphia
// because Google falls back to name matching when the location modifier is
// soft. We pass these as `locationRestriction` (hard exclusion of anything
// outside the circle) instead of `locationBias` (just a soft preference).
//
// Coordinates are approximate town centers. Radius is 25 km for towns — wide
// enough to catch nearby businesses that might serve the town, tight enough
// to exclude North/Central NJ and out-of-state. Counties get a 35 km radius
// around their county-seat-ish centroid.
const SOUTH_JERSEY_TOWN_COORDS = {
  'Voorhees':            { lat: 39.852, lng: -74.954 },
  'Marlton':             { lat: 39.891, lng: -74.921 },
  'Cherry Hill':         { lat: 39.934, lng: -75.030 },
  'Mount Laurel':        { lat: 39.937, lng: -74.890 },
  'Medford':             { lat: 39.901, lng: -74.823 },
  'Berlin':              { lat: 39.791, lng: -74.929 },
  'Hammonton':           { lat: 39.636, lng: -74.802 },
  'Williamstown':        { lat: 39.692, lng: -74.992 },
  'Glassboro':           { lat: 39.703, lng: -75.112 },
  'Deptford':            { lat: 39.834, lng: -75.106 },
  'Sewell':              { lat: 39.756, lng: -75.130 },
  'Washington Township': { lat: 39.751, lng: -75.045 },
  'Gloucester Township': { lat: 39.793, lng: -75.018 },
  'Haddonfield':         { lat: 39.891, lng: -75.038 },
  'Moorestown':          { lat: 39.969, lng: -74.948 },
  'Evesham':             { lat: 39.875, lng: -74.890 },
};

const SOUTH_JERSEY_COUNTY_COORDS = {
  'Burlington': { lat: 39.876, lng: -74.667 },
  'Camden':     { lat: 39.800, lng: -75.020 },
  'Gloucester': { lat: 39.717, lng: -75.135 },
  'Atlantic':   { lat: 39.470, lng: -74.640 },
  'Cumberland': { lat: 39.330, lng: -75.120 },
  'Salem':      { lat: 39.572, lng: -75.350 },
  'Cape May':   { lat: 39.080, lng: -74.830 },
};

// Radius tuned tighter than the original 25 km. Google ranks businesses by
// proximity *within* the restriction circle, and a wide radius lets popular
// Cherry Hill / Camden businesses dominate the results when we're searching
// Voorhees. 15 km gets us the genuinely-local results; the next town's sweep
// covers anything we miss in the gap.
const PLACES_TOWN_RADIUS_M   = 15_000;
const PLACES_COUNTY_RADIUS_M = 35_000;

// `searchPhrases` per category — multiple phrasings of the same intent.
// Google ranks `searchText` differently for each phrase, so running all 2-3
// per category surfaces businesses Google buries in the default ranking.
// Those buried businesses tend to be Nate's ideal customers (weak SEO =
// great prospect).
//
// Defaults to [category.name.toLowerCase()] if not specified.

// Category tiers drive Ability-to-Pay and Fit scores.
// 'disqualify' categories are excluded outright unless manually overridden.
const CATEGORIES = [
  // High-ticket, phone-driven, lead-hungry — ideal JPW customers
  { name: 'Tree Service',           tier: 'high', emergency: false, searchPhrases: ['tree service', 'tree removal', 'arborist'] },
  { name: 'Stump Grinding',         tier: 'high', emergency: false, searchPhrases: ['stump grinding', 'stump removal'] },
  { name: 'Roofing',                tier: 'high', emergency: false, searchPhrases: ['roofing contractor', 'roof repair', 'roofers'] },
  { name: 'Septic Service',         tier: 'high', emergency: true,  searchPhrases: ['septic service', 'septic pumping', 'septic tank repair'] },
  { name: 'Well Drilling',          tier: 'high', emergency: false, searchPhrases: ['well drilling', 'water well contractor'] },
  { name: 'Well Pump Repair',       tier: 'high', emergency: true,  searchPhrases: ['well pump repair', 'water pump service'] },
  { name: 'Excavation',             tier: 'high', emergency: false, searchPhrases: ['excavation contractor', 'excavating', 'site work contractor'] },
  { name: 'Drainage',               tier: 'high', emergency: false, searchPhrases: ['drainage contractor', 'french drain installation'] },
  { name: 'Grading',                tier: 'high', emergency: false, searchPhrases: ['land grading', 'lot grading'] },
  { name: 'Land Clearing',          tier: 'high', emergency: false, searchPhrases: ['land clearing', 'brush clearing'] },
  { name: 'Basement Waterproofing', tier: 'high', emergency: false, searchPhrases: ['basement waterproofing', 'wet basement repair'] },
  { name: 'Foundation Repair',      tier: 'high', emergency: false, searchPhrases: ['foundation repair', 'foundation contractor'] },
  { name: 'Pest Control',           tier: 'high', emergency: false, searchPhrases: ['pest control', 'exterminator', 'termite control'] },
  { name: 'Chimney',                tier: 'high', emergency: false, searchPhrases: ['chimney sweep', 'chimney repair', 'fireplace contractor'] },
  { name: 'Restoration',            tier: 'high', emergency: true,  searchPhrases: ['restoration company', 'disaster restoration', 'damage restoration'] },
  { name: 'Water Damage Restoration', tier: 'high', emergency: true, searchPhrases: ['water damage restoration', 'flood damage restoration', 'water cleanup'] },
  { name: 'Mold Remediation',       tier: 'high', emergency: true,  searchPhrases: ['mold remediation', 'mold removal'] },
  { name: 'Demolition',             tier: 'high', emergency: false, searchPhrases: ['demolition contractor', 'demolition services'] },
  { name: 'Environmental Remediation', tier: 'high', emergency: false, searchPhrases: ['environmental remediation', 'asbestos removal'] },
  { name: 'Hardscaping',            tier: 'high', emergency: false, searchPhrases: ['hardscaping', 'paver patio installation', 'masonry contractor'] },
  { name: 'Concrete',               tier: 'high', emergency: false, searchPhrases: ['concrete contractor', 'cement contractor', 'concrete driveway'] },
  { name: 'Asphalt Paving',         tier: 'high', emergency: false, searchPhrases: ['asphalt paving', 'driveway paving', 'paving contractor'] },
  { name: 'Fence Companies',        tier: 'high', emergency: false, searchPhrases: ['fence contractor', 'fence installation', 'fence company'] },
  { name: 'Siding',                 tier: 'high', emergency: false, searchPhrases: ['siding contractor', 'siding installation', 'vinyl siding'] },
  { name: 'Gutter Installation',    tier: 'high', emergency: false, searchPhrases: ['gutter installation', 'seamless gutters', 'gutter contractor'] },
  { name: 'HVAC',                   tier: 'high', emergency: true,  searchPhrases: ['hvac contractor', 'heating and cooling', 'air conditioning repair'] },
  { name: 'Plumbing',               tier: 'high', emergency: true,  searchPhrases: ['plumber', 'plumbing contractor', 'emergency plumber'] },
  { name: 'Electrical',             tier: 'high', emergency: true,  searchPhrases: ['electrician', 'electrical contractor', 'residential electrician'] },
  { name: 'Garage Doors',           tier: 'high', emergency: false, searchPhrases: ['garage door installation', 'garage door repair'] },
  { name: 'Insulation',             tier: 'high', emergency: false, searchPhrases: ['insulation contractor', 'spray foam insulation', 'attic insulation'] },
  { name: 'Crawlspace Repair',      tier: 'high', emergency: false, searchPhrases: ['crawl space repair', 'crawl space encapsulation'] },

  // Mid-ticket — still workable but not ideal
  { name: 'Landscaping',            tier: 'mid',  emergency: false, searchPhrases: ['landscaping', 'landscape contractor'] },
  { name: 'Painting',               tier: 'mid',  emergency: false, searchPhrases: ['painting contractor', 'house painter'] },
  { name: 'Junk Removal',           tier: 'mid',  emergency: false, searchPhrases: ['junk removal', 'hauling service'] },
  { name: 'Cleaning Services',      tier: 'mid',  emergency: false, searchPhrases: ['cleaning service', 'commercial cleaning'] },
  { name: 'Auto Repair',            tier: 'mid',  emergency: false, searchPhrases: ['auto repair', 'mechanic'] },

  // Disqualified — penalty in scoring, hidden by default in UI
  { name: 'Restaurant',             tier: 'disqualify' },
  { name: 'Salon',                  tier: 'disqualify' },
  { name: 'Retail Store',           tier: 'disqualify' },
  { name: 'Coffee Shop',            tier: 'disqualify' },
];

const CATEGORY_BY_NAME = Object.fromEntries(
  CATEGORIES.map((c) => [c.name.toLowerCase(), c])
);

// Loose match — many CSV/Apify exports return raw Google category strings
// ("Tree service near...", "Plumber", "Roofing contractor"). We map to our
// canonical names by keyword. Order matters; most-specific patterns first.
const CATEGORY_KEYWORDS = [
  [/\b(tree\s+removal|tree\s+service|arbor)/i,       'Tree Service'],
  [/\b(stump\s+grind|stump\s+removal)/i,             'Stump Grinding'],
  [/\b(roof|roofer)/i,                               'Roofing'],
  [/\b(septic)/i,                                    'Septic Service'],
  [/\b(well\s+drill)/i,                              'Well Drilling'],
  [/\b(well\s+pump)/i,                               'Well Pump Repair'],
  [/\b(excavat|earthwork|earth\s+moving)/i,          'Excavation'],
  [/\b(drainage|french\s+drain)/i,                   'Drainage'],
  [/\b(land\s+clear|brush\s+clear)/i,                'Land Clearing'],
  [/\b(waterproof|basement\s+waterproof)/i,          'Basement Waterproofing'],
  [/\b(foundation\s+repair|foundation\s+contractor)/i, 'Foundation Repair'],
  [/\b(pest|extermin|termite)/i,                     'Pest Control'],
  [/\b(chimney|hearth|fireplace)/i,                  'Chimney'],
  [/\b(water\s+damage|fire\s+damage|restoration\s+(co|llc|company|service))/i, 'Water Damage Restoration'],
  [/\b(mold)/i,                                      'Mold Remediation'],
  [/\b(demolition|demo\s+contractor)/i,              'Demolition'],
  [/\b(hardscape|paver|patio)/i,                     'Hardscaping'],
  [/\b(concrete|cement\s+contractor)/i,              'Concrete'],
  [/\b(asphalt|paving|pavement)/i,                   'Asphalt Paving'],
  [/\b(fence|fencing)/i,                             'Fence Companies'],
  [/\b(siding)/i,                                    'Siding'],
  [/\b(gutter)/i,                                    'Gutter Installation'],
  [/\b(hvac|heating\s+(and|&)\s+cooling|air\s+condition)/i, 'HVAC'],
  [/\b(plumb)/i,                                     'Plumbing'],
  [/\b(electric|electrician)/i,                      'Electrical'],
  [/\b(garage\s+door)/i,                             'Garage Doors'],
  [/\b(insulation|spray\s+foam)/i,                   'Insulation'],
  [/\b(crawl\s*space|crawlspace)/i,                  'Crawlspace Repair'],
  [/\b(landscap|lawn\s+care|lawn\s+service)/i,       'Landscaping'],
  [/\b(paint|painter)/i,                             'Painting'],
  [/\b(junk\s+removal|hauling)/i,                    'Junk Removal'],
  [/\b(cleaning|janitorial)/i,                       'Cleaning Services'],
  [/\b(auto\s+repair|mechanic)/i,                    'Auto Repair'],
  [/\b(restaurant|pizz|sushi|taqueria|bar\s*&\s*grill)/i, 'Restaurant'],
  [/\b(salon|barber|spa|nails)/i,                    'Salon'],
];

// Best-effort guess at our canonical category from any free-text string
// (a Google "type", an Apify "category", a user-typed industry, etc.).
function guessCategory(raw = '') {
  if (!raw) return '';
  const exact = CATEGORY_BY_NAME[raw.toLowerCase()];
  if (exact) return exact.name;
  for (const [rx, name] of CATEGORY_KEYWORDS) {
    if (rx.test(raw)) return name;
  }
  return raw; // unknown — keep the original so the user can re-map later
}

function categoryMeta(name = '') {
  return CATEGORY_BY_NAME[(name || '').toLowerCase()] || null;
}

// Score breakdown caps (mirror of GPT spec; keep here so the engine and the
// UI agree on what 100 means).
const SCORE_CAPS = {
  buyingIntent: 30,
  pain:         25,
  abilityToPay: 25,
  fit:          15,
  urgency:      5,
};
const SCORE_TOTAL_CAP = Object.values(SCORE_CAPS).reduce((a, b) => a + b, 0); // 100

const GRADE_THRESHOLDS = [
  { grade: 'A+', min: 82 },
  { grade: 'A',  min: 72 },
  { grade: 'B',  min: 60 },
  { grade: 'C',  min: 45 },
  { grade: 'D',  min: -Infinity },
];

function gradeFor(score) {
  for (const t of GRADE_THRESHOLDS) {
    if (score >= t.min) return t.grade;
  }
  return 'D';
}

const OFFERS = {
  foundation:    'Website Foundation',
  localSeo:      'Local SEO & Google Presence',
  metaAds:       'Meta Ads Management',
  fullGrowth:    'Full Growth System',
};

const CALL_STATUSES = [
  'new', 'call_today', 'called_no_answer', 'left_voicemail', 'gatekeeper',
  'interested', 'audit_requested', 'booked', 'not_fit', 'do_not_call', 'follow_up',
];

module.exports = {
  SOUTH_JERSEY_TOWNS,
  SOUTH_JERSEY_COUNTIES,
  SOUTH_JERSEY_TOWN_COORDS,
  SOUTH_JERSEY_COUNTY_COORDS,
  PLACES_TOWN_RADIUS_M,
  PLACES_COUNTY_RADIUS_M,
  CATEGORIES,
  CATEGORY_BY_NAME,
  guessCategory,
  categoryMeta,
  SCORE_CAPS,
  SCORE_TOTAL_CAP,
  GRADE_THRESHOLDS,
  gradeFor,
  OFFERS,
  CALL_STATUSES,
};
