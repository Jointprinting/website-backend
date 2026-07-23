// utils/time.js
//
// Business-timezone date helpers. The shop is run from New Jersey (US Eastern),
// but the server runs in UTC — which is *ahead* of Eastern. So after ~8pm ET the
// server's calendar day has already rolled to "tomorrow", which made the CRM's
// "today / overdue / due-today" wrong for the owner in the evening.
//
// Everything that decides a *calendar-day boundary* ("is this due today?",
// "is this overdue?") must reason in the business timezone, not the server's.
// These helpers do exactly that, using only the built-in Intl APIs (no new
// dependency) and handling DST automatically (EDT/UTC-4 in summer, EST/UTC-5 in
// winter — the offset is derived from the actual instant, never hardcoded).
//
// IMPORTANT: these are for day-boundary logic only. True audit instants
// (createdAt, log `at`, lastContact-as-a-moment) stay real Dates — only the
// "which calendar day is it" comparisons route through here.

const BUSINESS_TZ = 'America/New_York';

// The wall-clock Y/M/D for an instant in the business timezone, as numbers.
function etYmd(date = new Date(), tz = BUSINESS_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

// The UTC offset (in ms) in effect for `tz` at the given instant. Positive east
// of UTC, negative west — Eastern is negative (GMT-4 in summer, GMT-5 in winter).
// Derived from the zone's own longOffset name so DST is always correct.
function tzOffsetMs(date, tz = BUSINESS_TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
  const namepart = fmt.formatToParts(date).find((p) => p.type === 'timeZoneName');
  const m = namepart && namepart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0; // GMT/UTC itself reports e.g. "GMT" with no offset
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  return sign * (hours * 60 + mins) * 60000;
}

// Zero-padded YYYY-MM-DD from a {y,m,d}.
function ymdKey({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "Today" in the business timezone as a YYYY-MM-DD string. With no argument it's
// today; pass an instant to ask "what ET calendar day was this?".
function etToday(now = new Date()) {
  return ymdKey(etYmd(now));
}

// The ET calendar day of an *instant* (Date/ISO), as YYYY-MM-DD — i.e. "what
// Eastern day did this moment happen on". Use for real timestamps you want to
// bucket by the owner's day. Returns '' for a missing/invalid value.
//
// NOTE: do NOT use this for whole-day fields like nextFollowUp — those are
// stored at UTC midnight and their intended calendar day is their *UTC* day
// (a "2026-06-24" follow-up is the instant 2026-06-24T00:00:00Z, which in ET
// reads as 6/23 ~8pm). For those, use utcDayKey(). See compare-by-day below.
function etDayKey(value) {
  if (value == null) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return ymdKey(etYmd(d));
}

// The UTC calendar day of a Date/ISO, as YYYY-MM-DD. This is the intended day of
// a whole-day field (nextFollowUp / lastContact stored at UTC midnight), and it
// matches how the frontend turns a <input type="date"> "YYYY-MM-DD" into a Date.
// Returns '' for a missing/invalid value.
function utcDayKey(value) {
  if (value == null) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Whole-day relation of a stored whole-day field to the owner's today.
//   < 0  → the field's day is BEFORE today  (overdue)
//   = 0  → it's today                       (due today)
//   > 0  → it's after today                 (upcoming, N days out)
// Compares the field's UTC calendar day to today's ET calendar day (the two
// "what day is it" notions that actually matter), so a 6/24 follow-up is
// "due today" exactly when it's 6/24 in Eastern — never a few hours early.
function dayDiffFromToday(value, now = new Date()) {
  const key = utcDayKey(value);
  if (!key) return null;
  const a = Date.parse(`${etToday(now)}T00:00:00Z`);
  const b = Date.parse(`${key}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// Whole ET-calendar-day distance from a past instant to now: 0 = same Eastern
// day, 1 = it happened yesterday ET, etc. — counting the owner's day boundaries,
// NOT elapsed 24-hour blocks. The outreach warm-up ramp uses this so a weekly
// cap step lands at the start of a business day, never mid-send-window (a
// timestamp-anchored floor((now-then)/86400000) flips the cap at the anchor's
// wall-clock hour, which left ramp-boundary days short of their new cap).
// Returns null for a missing/invalid value.
function etDaysSince(value, now = new Date()) {
  const key = etDayKey(value);
  if (!key) return null;
  const a = Date.parse(`${key}T00:00:00Z`);
  const b = Date.parse(`${etToday(now)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// The exact UTC instant of 00:00:00.000 *in the business timezone* on the ET
// calendar day that `now` falls on. (e.g. for an instant on 6/23 ET in summer →
// 2026-06-23T04:00:00Z.) Compare a real timestamp `>= etStartOfToday()` to ask
// "is this at/after the start of the owner's today?".
function etStartOfToday(now = new Date()) {
  const { y, m, d } = etYmd(now);
  // Treat the ET wall-clock midnight as if it were UTC, then shift by the offset
  // that's actually in effect at (approximately) that instant.
  const asUtc = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const off = tzOffsetMs(new Date(asUtc), BUSINESS_TZ);
  return new Date(asUtc - off);
}

// The exact UTC instant of 23:59:59.999 in the business timezone on today's ET
// calendar day. Equivalent to start-of-tomorrow minus 1ms; computed directly so
// it's robust across the DST switch days.
function etEndOfToday(now = new Date()) {
  const { y, m, d } = etYmd(now);
  const asUtc = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  const off = tzOffsetMs(new Date(asUtc), BUSINESS_TZ);
  return new Date(asUtc - off);
}

// Start-of-day instant for an arbitrary ET calendar day, N days from today.
// (etStartOfToday() === etStartOfDay(0).) Used to build the rolling "this week"
// window on ET-day boundaries.
function etStartOfDay(offsetDays = 0, now = new Date()) {
  const base = etStartOfToday(now);
  if (!offsetDays) return base;
  // Add whole days, then re-snap to ET midnight so a DST transition inside the
  // window can't drift the boundary by an hour.
  const shifted = new Date(base.getTime() + offsetDays * 86400000);
  return etStartOfToday(shifted);
}

module.exports = {
  BUSINESS_TZ,
  etToday,
  etDayKey,
  etDaysSince,
  utcDayKey,
  dayDiffFromToday,
  etStartOfToday,
  etEndOfToday,
  etStartOfDay,
  // exported for tests / advanced callers
  etYmd,
  tzOffsetMs,
};
