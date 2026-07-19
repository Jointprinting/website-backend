// services/dispensaryStates.js
//
// Registry of US cannabis retail markets — the single source of truth for
// which states the Field Map treats as "pitchable" and where each state's
// authoritative dispensary roster lives. BOTH market kinds carry rosters:
// adult-use (REC_STATES) and medical-only (MED_STATES) — the owner pitches
// med dispensaries too (the map's MED clicker), so a med-only state like PA
// gets the same license-roll ingestion as NJ instead of rendering empty.
//
// The frontend keeps a commented mirror of REC_STATE_CODES / MEDICAL_ONLY in
// src/screens/studio/_roadTrip.js — update both together.
//
// Roster source kinds (services/dispensaryIngest.js consumes these):
//   'socrata'    — state open-data JSON API (best: filterable, always fresh)
//   'csv'        — a direct CSV download URL
//   'cannlytics' — the open Cannlytics cannabis_licenses aggregate on Hugging
//                  Face (per-state CSV). Community-maintained; good bootstrap
//                  for states whose regulators only publish PDF/HTML.
//   'google'     — no machine-readable roster wired yet; seed via the Google
//                  Places sweep (stores land as verified:false).
//
// Every state falls back cannlytics → google if its primary source fails, so
// a broken URL degrades to "less verified data", never to an empty map.
// Ingest also accepts a sourceUrlOverride so a moved roster can be re-pointed
// from the admin UI without a deploy.

// Cannlytics per-state subset CSV. `latest` tracks the newest collection run.
const cannlyticsUrl = (st) =>
  `https://huggingface.co/datasets/cannlytics/cannabis_licenses/resolve/main/data/${st}/licenses-${st}-latest.csv`;

// ── Adult-use states with OPERATING retail (mid-2026: 24 states) ────────────
// approxRetail = rough open-store count (for the coverage panel's sanity
// check — an ingest that lands wildly below this gets flagged in the report).
const REC_STATES = {
  AK: { name: 'Alaska',        approxRetail: 160,  roster: { kind: 'cannlytics', url: cannlyticsUrl('ak'), homepage: 'https://www.commerce.alaska.gov/web/amco/' } },
  AZ: { name: 'Arizona',       approxRetail: 175,  roster: { kind: 'cannlytics', url: cannlyticsUrl('az'), homepage: 'https://www.azdhs.gov/licensing/marijuana/' } },
  CA: { name: 'California',    approxRetail: 1200, roster: { kind: 'cannlytics', url: cannlyticsUrl('ca'), homepage: 'https://search.cannabis.ca.gov/' } },
  CO: { name: 'Colorado',      approxRetail: 650,  roster: { kind: 'cannlytics', url: cannlyticsUrl('co'), homepage: 'https://med.colorado.gov/licensee-information-and-lookup-tool/licensed-facilities' } },
  CT: {
    name: 'Connecticut', approxRetail: 55,
    roster: {
      kind: 'socrata',
      // "Licensed Cannabis and Medical Marijuana Retail Locations" — already
      // retail-only, so no type filter needed beyond the adult-use check.
      url: 'https://data.ct.gov/resource/42yd-3x3d.json?$limit=5000',
      homepage: 'https://portal.ct.gov/cannabis',
    },
  },
  DE: { name: 'Delaware',      approxRetail: 18,   roster: { kind: 'google', homepage: 'https://omc.delaware.gov/' } },
  IL: { name: 'Illinois',      approxRetail: 202,  roster: { kind: 'cannlytics', url: cannlyticsUrl('il'), homepage: 'https://idfpr.illinois.gov/profs/adultusecan.html' } },
  MA: { name: 'Massachusetts', approxRetail: 400,  roster: { kind: 'cannlytics', url: cannlyticsUrl('ma'), homepage: 'https://masscannabiscontrol.com/open-data/' } },
  MD: { name: 'Maryland',      approxRetail: 110,  roster: { kind: 'cannlytics', url: cannlyticsUrl('md'), homepage: 'https://cannabis.maryland.gov/Pages/Dispensary-Locator.aspx' } },
  ME: { name: 'Maine',         approxRetail: 180,  roster: { kind: 'cannlytics', url: cannlyticsUrl('me'), homepage: 'https://www.maine.gov/dafs/ocp/' } },
  MI: { name: 'Michigan',      approxRetail: 835,  roster: { kind: 'cannlytics', url: cannlyticsUrl('mi'), homepage: 'https://www.michigan.gov/cra' } },
  MN: { name: 'Minnesota',     approxRetail: 80,   roster: { kind: 'cannlytics', url: cannlyticsUrl('mn'), homepage: 'https://mn.gov/ocm/' } },
  MO: { name: 'Missouri',      approxRetail: 224,  roster: { kind: 'cannlytics', url: cannlyticsUrl('mo'), homepage: 'https://health.mo.gov/safety/cannabis/licensed-facilities.php' } },
  MT: { name: 'Montana',       approxRetail: 214,  roster: { kind: 'cannlytics', url: cannlyticsUrl('mt'), homepage: 'https://mtrevenue.gov/cannabis/' } },
  NJ: { name: 'New Jersey',    approxRetail: 250,  roster: { kind: 'cannlytics', url: cannlyticsUrl('nj'), homepage: 'https://www.nj.gov/cannabis/' } },
  NM: { name: 'New Mexico',    approxRetail: 1000, roster: { kind: 'cannlytics', url: cannlyticsUrl('nm'), homepage: 'https://crop.rld.nm.gov/dispensaries.html' } },
  NV: { name: 'Nevada',        approxRetail: 100,  roster: { kind: 'cannlytics', url: cannlyticsUrl('nv'), homepage: 'https://ccb.nv.gov/list-of-licensees/' } },
  NY: {
    name: 'New York', approxRetail: 600,
    roster: {
      kind: 'socrata',
      // "Current OCM Licenses" — all license classes; ingest filters to
      // adult-use retail (type ~ /retail dispensary|microbusiness/i).
      url: 'https://data.ny.gov/resource/jskf-tt3q.json?$limit=10000',
      homepage: 'https://cannabis.ny.gov/dispensary-location-verification',
      typeFilter: /retail\s*dispensar|microbusiness/i,
    },
  },
  OH: { name: 'Ohio',          approxRetail: 190,  roster: { kind: 'cannlytics', url: cannlyticsUrl('oh'), homepage: 'https://com.ohio.gov/divisions-and-programs/cannabis-control/' } },
  OR: { name: 'Oregon',        approxRetail: 650,  roster: { kind: 'cannlytics', url: cannlyticsUrl('or'), homepage: 'https://www.oregon.gov/olcc/marijuana/pages/recreational-marijuana-licensee-reports.aspx' } },
  RI: { name: 'Rhode Island',  approxRetail: 8,    roster: { kind: 'cannlytics', url: cannlyticsUrl('ri'), homepage: 'https://ccc.ri.gov/' } },
  VT: { name: 'Vermont',       approxRetail: 75,   roster: { kind: 'cannlytics', url: cannlyticsUrl('vt'), homepage: 'https://ccb.vermont.gov/licenses' } },
  WA: { name: 'Washington',    approxRetail: 470,  roster: { kind: 'cannlytics', url: cannlyticsUrl('wa'), homepage: 'https://lcb.wa.gov/records/frequently-requested-lists' } },
};

// ── Medical-only states with OPERATING retail (rosters wired like rec) ───────
// These are real licensed dispensary markets — the MED segment on the map.
// Rosters ride the same cannlytics aggregate the rec states use; a state whose
// CSV is missing simply reports sourceErrors and stays OSM-fed (the medical
// tag-net in scan-osm) until a roster lands. approxRetail is the coverage
// panel's sanity number, not a hard bound — FL/PA license one COMPANY per row
// with multiple storefronts, so those land intentionally low.
const MED_STATES = {
  AL: { name: 'Alabama',       approxRetail: 5,    roster: { kind: 'cannlytics', url: cannlyticsUrl('al'), homepage: 'https://amcc.alabama.gov/' } },
  AR: { name: 'Arkansas',      approxRetail: 38,   roster: { kind: 'cannlytics', url: cannlyticsUrl('ar'), homepage: 'https://www.healthy.arkansas.gov/programs-services/topics/medical-marijuana' } },
  FL: { name: 'Florida',       approxRetail: 650,  roster: { kind: 'cannlytics', url: cannlyticsUrl('fl'), homepage: 'https://knowthefactsmmj.com/mmtc/' } },
  HI: { name: 'Hawaii',        approxRetail: 35,   roster: { kind: 'cannlytics', url: cannlyticsUrl('hi'), homepage: 'https://health.hawaii.gov/medicalcannabis/' } },
  KY: { name: 'Kentucky',      approxRetail: 60,   roster: { kind: 'cannlytics', url: cannlyticsUrl('ky'), homepage: 'https://kymedcan.ky.gov/' } },
  LA: { name: 'Louisiana',     approxRetail: 30,   roster: { kind: 'cannlytics', url: cannlyticsUrl('la'), homepage: 'https://www.lsbap.com/' } },
  MS: { name: 'Mississippi',   approxRetail: 190,  roster: { kind: 'cannlytics', url: cannlyticsUrl('ms'), homepage: 'https://www.mmcp.ms.gov/' } },
  ND: { name: 'North Dakota',  approxRetail: 8,    roster: { kind: 'cannlytics', url: cannlyticsUrl('nd'), homepage: 'https://www.hhs.nd.gov/mm' } },
  NH: { name: 'New Hampshire', approxRetail: 7,    roster: { kind: 'cannlytics', url: cannlyticsUrl('nh'), homepage: 'https://www.dhhs.nh.gov/programs-services/health-care/therapeutic-cannabis-program' } },
  OK: { name: 'Oklahoma',      approxRetail: 2000, roster: { kind: 'cannlytics', url: cannlyticsUrl('ok'), homepage: 'https://oklahoma.gov/omma.html' } },
  PA: { name: 'Pennsylvania',  approxRetail: 190,  roster: { kind: 'cannlytics', url: cannlyticsUrl('pa'), homepage: 'https://www.pa.gov/agencies/health/programs/medical-marijuana.html' } },
  SD: { name: 'South Dakota',  approxRetail: 80,   roster: { kind: 'cannlytics', url: cannlyticsUrl('sd'), homepage: 'https://medcannabis.sd.gov/' } },
  UT: { name: 'Utah',          approxRetail: 15,   roster: { kind: 'cannlytics', url: cannlyticsUrl('ut'), homepage: 'https://medicalcannabis.utah.gov/' } },
  WV: { name: 'West Virginia', approxRetail: 50,   roster: { kind: 'cannlytics', url: cannlyticsUrl('wv'), homepage: 'https://omc.wv.gov/' } },
};

// Codes-only view kept for every existing consumer (coverage rollup, segment
// derivation, frontend mirror). Derived from MED_STATES so the two can't drift.
const MEDICAL_ONLY = Object.keys(MED_STATES);
// Possession legal but no stores to pitch (VA retail expected ~mid-2027).
const NO_RETAIL_YET = ['VA', 'DC'];

const REC_STATE_CODES = Object.keys(REC_STATES);

// Every state the ingest can roster-load, rec and med alike.
const ROSTER_STATES = { ...REC_STATES, ...MED_STATES };

// ── Market segment ────────────────────────────────────────────────────────────
// Every retail pin belongs to one of the owner's three pitch segments:
//   'rec'  — licensed adult-use market (the classic dispensary)
//   'med'  — licensed medical-only market
//   'hemp' — hemp-derived-THC retail ("bodega THC": delta-8 / THCA smoke, vape
//            and CBD shops in states with no legal marijuana retail — Texas,
//            the Carolinas, Tennessee, Georgia…). Legally volatile: the federal
//            hemp redefinition (P.L. 119-37) bites Nov 2026 and TX/TN rules are
//            already shrinking flower sellers — the segment is a filter, never
//            a data deletion, so pins age out with their sources.
// Derivation is state+source-based (not persisted-only) so legacy rows and
// list drift (a state flipping rec) reclassify automatically at read time:
//   rec state                        → 'rec'
//   medical-only state, roster/google/manual → 'med'   (license-backed or
//            found via a "dispensary" text sweep — a real med dispensary)
//   medical-only state, osm          → 'med' when the find carried a medical/
//            trusted-cannabis TAG (opts.medical — a mapper-tagged shop in a
//            med state IS a licensed med dispensary), else 'hemp' (name-net
//            finds there are overwhelmingly CBD/hemp storefronts)
//   any other / unknown state        → 'hemp' when the state is a real code
//            (a cannabis-tagged shop where no marijuana retail is legal IS a
//            hemp shop), '' when the state is unparsed ('US'/'').
// '' (unknown) is deliberately never filtered out by segment reads.
// MIRROR: src/screens/studio/_roadTrip.js documents the segment vocabulary for
// the Field Map's clickers — keep the labels in sync.
function deriveSegment(state, source, opts = {}) {
  const st = String(state || '').toUpperCase();
  if (!st || st === 'US' || st.length !== 2) return '';
  if (REC_STATES[st]) return 'rec';
  if (MEDICAL_ONLY.includes(st)) {
    if (source !== 'osm') return 'med';
    return opts.medical ? 'med' : 'hemp';
  }
  return 'hemp';
}
const SEGMENTS = ['rec', 'med', 'hemp'];

module.exports = {
  REC_STATES, REC_STATE_CODES, MED_STATES, ROSTER_STATES,
  MEDICAL_ONLY, NO_RETAIL_YET, deriveSegment, SEGMENTS,
};
