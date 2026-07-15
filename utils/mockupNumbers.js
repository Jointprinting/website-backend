// utils/mockupNumbers.js
//
// The one source of truth for Mockup Lab numbering. A mockup number is:
//
//     #<6-digit base><letters><optional edit-version>
//     └─ project ──┘ └ color ┘ └── edit/version ──┘
//
//   #000150A   → project 150, colour variant A (e.g. red), original
//   #000150B   → project 150, colour variant B (e.g. black), original
//   #000150A2  → project 150, colour A, first EDIT (version 2)
//   #000150Z   → 26th colour; the 27th overflows to…
//   #000150AA  → …AA, then AB, AC … (bijective base-26, like spreadsheet cols)
//
// Owner's model (2026-07): LETTERS are garment-colour variants and stay separate
// mockups; the TRAILING NUMBER is the edit/version of one colour (a first edit of
// #150A is #150A2), and edits group under their original. Colours overflow past Z
// to AA/AB/… so a design can carry more than 26 without collision.
//
// Pure + dependency-free so BOTH the API (controllers/orders.js) and the studio
// editor can share the exact same math and never drift. Version 1 (the original)
// is written WITHOUT a trailing number — #150A, not #150A1.

// Bijective base-26: 'A'→1, 'Z'→26, 'AA'→27, 'AB'→28 … (spreadsheet columns).
function letterToNum(s) {
  let n = 0;
  for (const c of String(s || '').toUpperCase()) {
    const v = c.charCodeAt(0) - 64; // 'A' = 65
    if (v < 1 || v > 26) return 0;
    n = n * 26 + v;
  }
  return n;
}

function numToLetter(n) {
  let s = '';
  let x = Math.floor(n);
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

// The 6-digit, #-prefixed base for a project number ("150" or "150-2" → "#000150").
function baseForProject(projectNumber) {
  const raw = String(projectNumber || '').split('-')[0].replace(/\D/g, '');
  if (!raw) return '';
  return `#${raw.padStart(6, '0')}`;
}

// Split a full mockup number into its parts. Returns null when it doesn't parse.
//   '#000150A2' → { base:'#000150', digits:'000150', letter:'A', letterNum:1, version:2 }
// An original (no trailing number) reads as version 1.
function parseMockupNum(num) {
  const m = String(num || '').trim().match(/^#?(\d+)([A-Za-z]+)(\d+)?$/);
  if (!m) return null;
  const digits = m[1];
  const letter = m[2].toUpperCase();
  const letterNum = letterToNum(letter);
  if (!letterNum) return null;
  const version = m[3] ? parseInt(m[3], 10) : 1;
  if (!version || version < 1) return null;
  return { base: `#${digits}`, digits, letter, letterNum, version };
}

// Build a number from parts. Version ≤ 1 (the original) carries no trailing number.
function formatMockupNum(base, letter, version = 1) {
  const b = String(base || '');
  const withHash = b.startsWith('#') ? b : `#${b}`;
  const v = Math.floor(version) || 1;
  return `${withHash}${String(letter || '').toUpperCase()}${v > 1 ? v : ''}`;
}

// Numbers on a project that belong to a given base (defensive against mixed lists).
function _onBase(base, existing) {
  return (existing || [])
    .map(parseMockupNum)
    .filter((p) => p && p.base === base);
}

// The next COLOUR variant for a project: max existing letter + 1, overflowing
// A→Z→AA. Counts every colour regardless of edit-version (an edit doesn't consume
// a new colour). Returns the full number, e.g. '#000150C', or '' with no base.
function nextColorLetter(projectNumber, existing) {
  const base = baseForProject(projectNumber);
  if (!base) return '';
  const maxLetter = _onBase(base, existing).reduce((mx, p) => Math.max(mx, p.letterNum), 0);
  return `${base}${numToLetter(maxLetter + 1)}`;
}

// The next EDIT VERSION of one colour on a project: the source's base+letter with
// max existing version + 1 (min 2, since the original is version 1 / no suffix).
// `sourceNum` is any number in that colour lane (#150A or #150A3). Returns the
// full next number, e.g. '#000150A2', or '' if the source doesn't parse.
function nextEditVersion(sourceNum, existing) {
  const src = parseMockupNum(sourceNum);
  if (!src) return '';
  const maxVersion = _onBase(src.base, existing)
    .filter((p) => p.letterNum === src.letterNum)
    .reduce((mx, p) => Math.max(mx, p.version), 1);
  return formatMockupNum(src.base, src.letter, Math.max(maxVersion + 1, 2));
}

// Back-compat shim for the old name (controllers/orders.js used _nextMockupLetter).
const nextMockupLetter = nextColorLetter;

module.exports = {
  letterToNum,
  numToLetter,
  baseForProject,
  parseMockupNum,
  formatMockupNum,
  nextColorLetter,
  nextEditVersion,
  nextMockupLetter,
};
