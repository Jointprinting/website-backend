// services/zipGeo.js
//
// WHERE A ZIP CODE IS, LEARNED FROM DATA THE BUSINESS ALREADY OWNS.
//
// The freight estimator resolved both ends of a shipment to STATE CENTRES, and
// a state centre is not where anyone lives. Michigan's is 300 miles north of
// Jackson, so an Ohio printer shipping to a Jackson dispensary measured 311 mi
// (zone 4) against a real leg of about 146 (zone 2) — roughly $25 of invented
// freight on a 300-shirt run, marked up and passed to the client.
//
// The fix needs coordinates for a ZIP, and there is no offline table of those
// in this codebase. There IS, however, a map: the dispensary finder has spent
// months collecting shops with `zip`, `lat` and `lng` (models/Dispensary), and
// the clients this estimator ships to ARE dispensaries. So the ZIPs it can
// place are exactly the ZIPs the business ships to.
//
// WHY ZIP3 (the first three digits) IS THE RIGHT GRAIN:
//   • It is a real postal unit — a sectional centre facility — covering tens of
//     miles, not hundreds. Zone bands are 150 miles wide, so a ZIP3 centroid is
//     comfortably inside the band its ZIP belongs to, while a state centroid is
//     routinely a whole band out.
//   • It generalizes. One dispensary in 492xx places every 492xx address,
//     including clients who are not dispensaries at all.
//   • It degrades honestly: an uncovered ZIP3 falls back to the state centre,
//     which is exactly today's behaviour. Nothing gets worse.
//
// PURE except for the loader — the index math is unit-tested, and the caller
// owns the query and the cache.

// '655 Ballard Rd. Jackson, MI 49201' → '49201'
// 'Jackson, MI 49201-1234'           → '49201'
// Deliberately anchored on a word boundary and 5 digits: a street number
// ('12345 Main St') would otherwise read as a ZIP, and a wrong ZIP is worse
// than none because it looks precise.
function parseZip(text) {
  const s = String(text == null ? '' : text);
  // Prefer a ZIP in trailing position (how an address ends), else any standalone
  // 5-digit group that is not followed by a street-ish word.
  const tail = s.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (tail) return tail[1];
  const all = [...s.matchAll(/\b(\d{5})(?:-\d{4})?\b(?!\s*[A-Za-z]{2,}\s*(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|way|ct|court)\b)/gi)];
  return all.length ? all[all.length - 1][1] : '';
}

// The sectional centre: the first three digits.
function zip3(zip) {
  const z = String(zip == null ? '' : zip).trim();
  return /^\d{5}/.test(z) ? z.slice(0, 3) : (/^\d{3}$/.test(z) ? z : '');
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Plausible US coordinates. A row with a transposed or zeroed lat/lng would drag
// a centroid across the country, so anything outside the continental-plus box is
// dropped rather than averaged in.
function usableRow(r) {
  const lat = num(r && (r.lat != null ? r.lat : r.latitude));
  const lon = num(r && (r.lng != null ? r.lng : (r.lon != null ? r.lon : r.longitude)));
  if (lat === null || lon === null) return null;
  if (lat < 18 || lat > 72) return null;         // PR/HI south, AK north
  if (lon < -180 || lon > -65) return null;
  const k = zip3(r && r.zip);
  if (!k) return null;
  return { k, lat, lon };
}

/**
 * Build the ZIP3 → centroid index. PURE.
 *
 * Averaging the members of a ZIP3 is the right summary: they are all inside one
 * postal sector, so the mean sits in that sector however many points there are.
 * `n` rides along so a caller can tell a well-sampled sector from a single shop.
 */
function buildZip3Index(rows) {
  const acc = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const u = usableRow(r);
    if (!u) continue;
    const cur = acc.get(u.k) || { lat: 0, lon: 0, n: 0 };
    cur.lat += u.lat; cur.lon += u.lon; cur.n += 1;
    acc.set(u.k, cur);
  }
  const out = {};
  for (const [k, v] of acc) {
    out[k] = { lat: +(v.lat / v.n).toFixed(4), lon: +(v.lon / v.n).toFixed(4), n: v.n };
  }
  return out;
}

// Coordinates for a ZIP (or a bare ZIP3), or null when the sector isn't covered.
// null is the honest answer — the caller then uses the state centre, which is
// what it did before this existed.
function lookupZip(index, zip) {
  const k = zip3(zip);
  if (!k || !index) return null;
  const hit = index[k];
  return hit ? { lat: hit.lat, lon: hit.lon, n: hit.n, zip3: k } : null;
}

// ── The live index ───────────────────────────────────────────────────────────
//
// Built from the dispensary map and held in memory. Rebuilt on a slow clock: a
// sector's centre does not move, and a new shop shifts it by yards, so there is
// nothing to gain from re-reading the collection per quote — and a quote must
// never wait on a scan to price a line.
//
// Fails SOFT on purpose. If the query errors or the collection is empty the
// index is empty, every lookup returns null, and the estimator uses state
// centres exactly as it did before any of this existed.
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
let _cache = { at: 0, index: null, points: 0, sectors: 0 };

async function loadZip3Index({ force = false } = {}) {
  const fresh = _cache.index && (Date.now() - _cache.at) < INDEX_TTL_MS;
  if (fresh && !force) return _cache;
  try {
    // Required here, not at module load: this file is pure-testable and must not
    // drag mongoose into a unit test.
    const Dispensary = require('../models/Dispensary');
    const rows = await Dispensary
      .find({ zip: { $ne: '' }, lat: { $ne: null }, lng: { $ne: null } })
      .select('zip lat lng')
      .lean();
    const index = buildZip3Index(rows);
    _cache = { at: Date.now(), index, points: rows.length, sectors: Object.keys(index).length };
  } catch (e) {
    console.warn('[zipGeo] could not build the ZIP index, falling back to state centres:', e.message);
    _cache = { at: Date.now(), index: {}, points: 0, sectors: 0 };
  }
  return _cache;
}

// Place a ZIP (or an address containing one). Returns null when the sector is
// uncovered — the caller then uses the state centre.
async function placeZip(zipOrAddress) {
  const zip = /^\d{5}/.test(String(zipOrAddress || '').trim())
    ? String(zipOrAddress).trim()
    : parseZip(zipOrAddress);
  if (!zip) return null;
  const { index } = await loadZip3Index();
  return lookupZip(index, zip);
}

module.exports = { parseZip, zip3, buildZip3Index, lookupZip, loadZip3Index, placeZip, INDEX_TTL_MS };
