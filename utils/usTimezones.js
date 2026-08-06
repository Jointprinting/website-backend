// utils/usTimezones.js
//
// State → IANA timezone, so outreach can land in the RECIPIENT's morning.
//
// The send window used to be one Eastern block for everybody, which is wrong in
// both directions on a national list: a 9am Eastern send reaches a Colorado shop
// at 7am and a California shop at 6am, before anyone is at the counter — and the
// window closing at 5pm Eastern gives up on the whole West Coast afternoon while
// it's still mid-morning there.
//
// Several states straddle two zones. Each is mapped to the zone holding most of
// its population and most of its licensed retail, because being an hour off for
// the Florida panhandle is a rounding error next to being three hours off for
// California. Arizona is the one that bites people: it does not observe DST, and
// America/Phoenix is what makes that correct without any special-casing here.

const STATE_TZ = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',        // no DST — the IANA zone handles it
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',       // panhandle is Central; the peninsula is not
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise',          // the panhandle is Pacific
  IL: 'America/Chicago',
  IN: 'America/New_York',       // a few northwest counties are Central
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',       // Louisville + Lexington
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/New_York',       // four western counties are Central
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',    // a sliver of the east is Mountain
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',        // Nashville and west; the east is Eastern
  TX: 'America/Chicago',        // El Paso is Mountain
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
  PR: 'America/Puerto_Rico',
};

// The distinct zones we actually schedule against — what the engine iterates to
// decide "is anyone's morning happening right now?".
const US_ZONES = [...new Set(Object.values(STATE_TZ))];

// Short labels for the Studio readout, so a pill can say "sending: ET · CT"
// instead of naming IANA identifiers at the owner.
const ZONE_LABEL = {
  'America/New_York': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Phoenix': 'AZ',
  'America/Boise': 'MT',
  'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AK',
  'Pacific/Honolulu': 'HI',
  'America/Puerto_Rico': 'AT',
};

const DEFAULT_TZ = 'America/New_York';

/**
 * The timezone to schedule a lead in. Accepts a state code or full name; falls
 * back to Eastern when the map holds nothing, because a lead with no state is
 * more likely to be an East-Coast referral than anything else — and mailing at a
 * defensible hour beats not mailing. PURE.
 */
function tzForState(state) {
  const raw = String(state || '').trim();
  if (!raw) return DEFAULT_TZ;
  const code = raw.length === 2 ? raw.toUpperCase() : STATE_CODE_BY_NAME[raw.toLowerCase()] || '';
  return STATE_TZ[code] || DEFAULT_TZ;
}

/** Short label for a zone ('ET'), for the Studio. PURE. */
const zoneLabel = (tz) => ZONE_LABEL[tz] || tz;

// Full names → codes, so a record that stores "Michigan" resolves too.
const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'puerto rico': 'PR', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const STATE_CODE_BY_NAME = STATE_NAMES;

module.exports = { STATE_TZ, US_ZONES, DEFAULT_TZ, tzForState, zoneLabel, ZONE_LABEL };
