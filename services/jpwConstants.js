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

const PLACES_TOWN_RADIUS_M   = 25_000; // 25 km — tight enough to exclude north/central NJ
const PLACES_COUNTY_RADIUS_M = 35_000; // 35 km — wider for county-only searches

// Category tiers drive Ability-to-Pay and Fit scores.
// 'disqualify' categories are excluded outright unless manually overridden.
const CATEGORIES = [
  // High-ticket, phone-driven, lead-hungry — ideal JPW customers
  { name: 'Tree Service',           tier: 'high', emergency: false },
  { name: 'Stump Grinding',         tier: 'high', emergency: false },
  { name: 'Roofing',                tier: 'high', emergency: false },
  { name: 'Septic Service',         tier: 'high', emergency: true  },
  { name: 'Well Drilling',          tier: 'high', emergency: false },
  { name: 'Well Pump Repair',       tier: 'high', emergency: true  },
  { name: 'Excavation',             tier: 'high', emergency: false },
  { name: 'Drainage',               tier: 'high', emergency: false },
  { name: 'Grading',                tier: 'high', emergency: false },
  { name: 'Land Clearing',          tier: 'high', emergency: false },
  { name: 'Basement Waterproofing', tier: 'high', emergency: false },
  { name: 'Foundation Repair',      tier: 'high', emergency: false },
  { name: 'Pest Control',           tier: 'high', emergency: false },
  { name: 'Chimney',                tier: 'high', emergency: false },
  { name: 'Restoration',            tier: 'high', emergency: true  },
  { name: 'Water Damage Restoration', tier: 'high', emergency: true },
  { name: 'Mold Remediation',       tier: 'high', emergency: true  },
  { name: 'Demolition',             tier: 'high', emergency: false },
  { name: 'Environmental Remediation', tier: 'high', emergency: false },
  { name: 'Hardscaping',            tier: 'high', emergency: false },
  { name: 'Concrete',               tier: 'high', emergency: false },
  { name: 'Asphalt Paving',         tier: 'high', emergency: false },
  { name: 'Fence Companies',        tier: 'high', emergency: false },
  { name: 'Siding',                 tier: 'high', emergency: false },
  { name: 'Gutter Installation',    tier: 'high', emergency: false },
  { name: 'HVAC',                   tier: 'high', emergency: true  },
  { name: 'Plumbing',               tier: 'high', emergency: true  },
  { name: 'Electrical',             tier: 'high', emergency: true  },
  { name: 'Garage Doors',           tier: 'high', emergency: false },
  { name: 'Insulation',             tier: 'high', emergency: false },
  { name: 'Crawlspace Repair',      tier: 'high', emergency: false },

  // Mid-ticket — still workable but not ideal
  { name: 'Landscaping',            tier: 'mid',  emergency: false },
  { name: 'Painting',               tier: 'mid',  emergency: false },
  { name: 'Junk Removal',           tier: 'mid',  emergency: false },
  { name: 'Cleaning Services',      tier: 'mid',  emergency: false },
  { name: 'Auto Repair',            tier: 'mid',  emergency: false },

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
