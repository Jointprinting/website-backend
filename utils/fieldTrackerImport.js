// utils/fieldTrackerImport.js
//
// Pure-logic helpers for the CRM "field tracker" import:
//   • parseCsv(text)         — a robust RFC-4180-ish CSV parser (quoted fields,
//                              embedded commas/newlines, "" escaped quotes).
//   • mapTrackerRow(row)     — map one owner field-tracker row → CRM patch.
//
// No DB / no Express here so it can be unit-tested directly against the real
// CSV.
//
// TWO keys, on purpose (this is the dedup fix):
//   • companyKey — IDENTITY. Byte-for-byte identical to models/Order.js
//     #deriveCompanyKey so a CRM record lines up with its Orders by key. Never
//     loosened — loosening it would silently MERGE different companies.
//   • matchKey   — a fuzzier grouping key used ONLY by the duplicate finder /
//     merge tooling. It strips corporate suffixes (inc/llc/co/...) + apostrophes
//     + punctuation so "Acme Inc" and "Acme, Inc." propose-merge, WITHOUT
//     touching identity (so "Bleu Leaf" and "Bleu Leaf Dispensary" stay
//     distinct — different stems). Suggestions only; merging is an explicit,
//     reversible owner action.

// Same normalization the rest of the system uses (models/Order.js). Kept inline
// (not imported) so this module stays dependency-free and testable in isolation,
// but it MUST stay byte-for-byte identical to deriveCompanyKey.
function deriveCompanyKey(companyName, clientName) {
  const raw = (companyName || clientName || '').toString();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Corporate suffixes we strip from the *match* key (NOT from identity). Word-
// boundary matched at the END of the name only, so "Incognito" keeps its "inc".
const CORP_SUFFIXES = ['incorporated', 'corporation', 'company', 'limited',
  'inc', 'llc', 'l.l.c', 'co', 'corp', 'ltd', 'lp', 'llp', 'plc'];

// Fuzzy grouping key. Lowercases, drops apostrophes (so "joe's" == "joes"),
// strips a trailing corporate suffix, then removes all remaining non-alphanum.
// Used ONLY to PROPOSE duplicate groups — never to decide identity on import.
// Returns '' when nothing is left (caller treats that as "no match key").
function matchKey(companyName, clientName) {
  let raw = (companyName || clientName || '').toString().toLowerCase();
  raw = raw.replace(/['’`]/g, '');             // apostrophes vanish, not split
  // Strip ONE trailing corp suffix (with optional punctuation/space before it).
  // e.g. "acme, inc." → "acme", "acme co" → "acme".
  for (const suf of CORP_SUFFIXES) {
    const re = new RegExp(`[\\s,.&-]+${suf.replace(/\./g, '\\.')}\\.?$`, 'i');
    if (re.test(raw)) { raw = raw.replace(re, ''); break; }
  }
  return raw.replace(/[^a-z0-9]+/g, '');
}

// ── CSV parser ───────────────────────────────────────────────────────────────
// Returns an array of rows; each row is an array of string cells. Handles:
//   • fields wrapped in double quotes
//   • commas and newlines inside quoted fields
//   • "" as an escaped double-quote inside a quoted field
//   • \r\n and \n line endings
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text == null ? '' : text);
  let i = 0;
  const n = s.length;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < n) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { endField(); i += 1; continue; }
    if (c === '\r') { i += 1; continue; }            // swallow CR (handle CRLF/CR)
    if (c === '\n') { endRow(); i += 1; continue; }
    field += c; i += 1;
  }
  // Flush trailing field/row (file may not end in a newline).
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

// Header → canonical-column aliases. ONE table now serves EVERY supported CSV
// layout (the owner's field-visit tracker, a Notion CRM export, and the loose
// Google "CRM" sheet). Matching is case/space/punctuation-insensitive (see
// normHeader), so "Next Follow-up", "next followup", and "Next Contact" all land
// on the same canonical `nextContact`. Adding a new source = adding its header
// spellings here; no parser branching per format.
//
// Keys are already normHeader-normalized (lowercase, no spaces, no punctuation).
const HEADER_ALIASES = {
  // ── identity ──
  companyname:   'companyName',
  clientname:    'clientName',   // Google sheet uses "Client Name"
  // ── contact person ──
  ownercontact:  'contact',
  contactperson: 'contact',      // Notion
  contact:       'contact',
  bestpoc:       'contact',      // Google sheet "Best POC"
  poc:           'contact',
  // ── channels ──
  phone:         'phone',
  contactphone:  'phone',        // Notion
  email:         'email',
  contactemail:  'email',        // Notion
  // ── classification ──
  area:          'area',
  address:       'address',      // exact street address (replaces "area" going forward)
  interested:    'interested',
  status:        'status',
  stage:         'status',       // Google sheet "Stage" → same status→stage mapper
  engagementlevel: 'engagement', // Notion "Engagement Level" (High/Medium/Low/Inactive)
  engagement:    'engagement',
  orderstatus:   'orderStatus',  // Notion "Order Status" multi-select (Completed/Paid/…)
  dealvalue:     'dealValue',    // Notion "Deal Value" ($ number)
  source:        'sourceField',  // Notion "Source" (where the lead came from)
  // ── dates ──
  lastcontact:     'lastContact',
  lastcontactdate: 'lastContact', // Notion "Last Contact Date"
  nextcontact:     'nextContact',
  next:            'nextContact', // Google sheet "Next"
  nextfollowup:    'nextContact', // Notion "Next Follow-up"
  nextaction:      'nextAction',
  // ── order linkage (THE customer signal) ──
  ordernumber:   'orderNumber',  // Notion "Order Number"
  order:         'orderNumber',  // Google sheet "Order #" (punctuation stripped)
  // ── free text ──
  notes:         'notes',
};

// Identity columns: a header row is "real" iff it names at least one of these
// (so a Notion/Google export with only "Company Name" or only "Client Name"
// still locates), plus we require a second recognized CRM column so we don't
// false-positive on a stray data row that happens to contain the word.
const IDENTITY_CANON = ['companyName', 'clientName'];

function normHeader(h) {
  // Lowercase, then drop EVERYTHING that isn't a letter or digit — so spaces,
  // slashes, hyphens, "?", "#", "." all vanish. "Owner / Contact" → "ownercontact",
  // "Next Follow-up" → "nextfollowup", "Order #" → "order", "Interested?" →
  // "interested". One normalizer for every alias lookup keeps matching uniform.
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Resolve one raw header cell to its canonical column name (or '' if unknown).
function canonHeader(cell) {
  return HEADER_ALIASES[normHeader(cell)] || '';
}

// Given a parsed CSV (array of arrays), find the header row and return
// { headerIndex, columns, format } where columns maps canonical-name → column
// index. Supports MULTIPLE layouts: the owner's field tracker has a title row
// ("Field Visit Tracker,,,..") above the headers; Notion/Google exports start
// straight at the header row. We scan for the FIRST row that both (a) names an
// identity column (Company/Client Name) and (b) carries ≥1 other recognized CRM
// column — that's the header row regardless of source.
function locateHeader(rows) {
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] || [];
    const columns = {};
    cells.forEach((cell, idx) => {
      const canon = canonHeader(cell);
      if (canon && !(canon in columns)) columns[canon] = idx;
    });
    const hasIdentity = IDENTITY_CANON.some((c) => c in columns);
    const otherCols = Object.keys(columns).filter((c) => !IDENTITY_CANON.includes(c)).length;
    if (hasIdentity && otherCols >= 1) {
      return { headerIndex: r, columns, format: detectFormat(columns, cells) };
    }
  }
  return { headerIndex: -1, columns: {}, format: 'unknown' };
}

// Best-effort label for WHICH source a header set came from. Informational only
// (surfaced in the import summary / for debugging) — the actual column mapping
// is identical across formats, so detection never changes how a row is parsed.
//   • 'notion'        — has the Notion-only "Contact Person"/"Contact Email" shape
//   • 'google-sheet'  — has "Best POC" or "Stage"/"Next" without the tracker's cols
//   • 'field-tracker' — the owner's tracker (Owner/Contact + Interested? + Area)
//   • 'csv'           — recognized CRM columns but no distinctive fingerprint
function detectFormat(columns, rawHeaderCells) {
  const norms = new Set((rawHeaderCells || []).map(normHeader));
  if (norms.has('contactperson') || norms.has('contactemail') || norms.has('nextfollowup')) return 'notion';
  if (norms.has('bestpoc') || norms.has('stage') || norms.has('next')) return 'google-sheet';
  if (norms.has('ownercontact') || norms.has('interested')) return 'field-tracker';
  // Fall back on the mapped columns when raw cells weren't passed.
  if ('interested' in columns && 'area' in columns) return 'field-tracker';
  return 'csv';
}

// ── Field mapping ─────────────────────────────────────────────────────────────

// Parse a dollar amount out of free text: "$2,500" → 2500, "2.5k" → 2500,
// "1,200.50" → 1200.5, "" → 0. Returns 0 for anything unparseable (treated as
// "unset" by the merge — never overwrites an owner-entered value).
function parseMoney(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return 0;
  const k = /\bk\b|k$/.test(v.replace(/[^a-z0-9.]/g, '')) || /\dk/.test(v);
  const cleaned = v.replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  let n = parseFloat(cleaned);
  if (isNaN(n)) return 0;
  if (k && n < 1000) n *= 1000;             // "2.5k" → 2500
  return Math.round(n * 100) / 100;
}

// Reverse of formatLabel — map a human source label back to a format key, so a
// caller that only has opts.sourceLabel (not opts.format) still gets the
// keep-cold/lost behavior right.
function labelToFormat(label) {
  const v = String(label || '').toLowerCase();
  if (v.includes('notion')) return 'notion';
  if (v.includes('sheet')) return 'google-sheet';
  if (v.includes('tracker')) return 'field-tracker';
  return 'csv';
}

// Record-provenance string (stored on Client.source) per detected format.
function provenanceFor(format) {
  if (format === 'notion') return 'notion';
  if (format === 'google-sheet') return 'crm-sheet';
  if (format === 'field-tracker') return 'field-tracker';
  return 'import';
}

// Interested? → interestType enum. Blank stays ''.
function mapInterest(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'promos' || v === 'promo')   return 'promos';
  if (v === 'apparel')                   return 'apparel';
  if (v === 'both')                      return 'both';
  return '';
}

// "interested? = no" detector. The tracker uses a few spellings for a hard no.
function interestIsNo(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'no' || v === 'n' || v === 'not interested' || v === 'none';
}

// Positive-contact keywords: ONLY these upgrade an unknown status to 'contacted'.
// (The old code defaulted EVERYTHING non-empty to 'contacted', which fabricated
// contact that never happened — e.g. a bare "left vm" became "contacted".)
const POSITIVE_CONTACT = ['visit', 'visited', 'contacted', 'pitch', 'pitched',
  'spoke', 'talked', 'met ', 'meeting', 'demo', 'samples dropped', 'dropped samples',
  'in person', 'walked in', 'stopped by'];

// Status keywords that imply the lead is DEAD or a non-contact (never a real
// touch we want to keep surfacing). Used by isDeadRow (a row is only skipped if
// it ALSO has no future follow-up).
const DEAD_STATUS = ['not interested', 'no answer', 'no-answer', 'noanswer',
  'left vm', 'left a vm', 'left voicemail', 'voicemail', 'vm only',
  'dnc', 'do not call', 'do not contact', 'wrong number', 'wrong #',
  'disconnected', 'closed', 'out of business', 'no longer', 'dead', 'bounced',
  'unsubscribe', 'removed'];

// Does this status text imply dead/non-contact?
function statusImpliesDead(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return false;
  return DEAD_STATUS.some((k) => v.includes(k));
}

// The owner's REAL Notion CRM Status option values (one DB spanning the whole
// funnel) + the loose temperature words his sheets use → { stage, tag }. Each
// row carries a stage AND a tag so the warmth/segment is never lost in the
// translation. Matched as a case-insensitive SUBSTRING, most-specific first.
//
// CRITICAL: Cold prospects and Lost (past) projects are REAL records the owner
// re-contacts — they map to lead/dormant and are KEPT, never skipped (the
// keep-cold/lost override lives in mapTrackerRow for CRM-DB sources).
//
//   "Hot (Clients)"            → contacted  + hot          (warmth only; customer comes from a placed Order)
//   "Won Orders"               → won        + won          (promotes to customer if it has a placed order)
//   "Orders In Progress"       → quoting    + in-progress  (in-flight; not yet a verified placed order)
//   "Warm (Leads)"             → contacted  + warm
//   "Room Temp (Opportunities)"→ contacted  + room-temp
//   "Cold (Prospects)"         → lead       + cold         (KEEP)
//   "Lost Orders"              → dormant    + lost          (KEEP — past project)
//   "Meta Ad Conversions"      → lead       + meta-ad
// Plus bare temperature words (hot/warm/cold/lukewarm/opportunity) for the sheets.
// SPECIFIC: Nate's exact Notion option values (a distinctive multi-word phrase).
// These are authoritative for BOTH stage and tag, and short-circuit mapStatus —
// "Won Orders" is won, "Warm (Leads)" is contacted, etc., and the generic
// free-text vocabulary can't override them. None of them yield 'customer':
// customer status is earned by a verified placed Order, not by a status word.
const STATUS_MAP_SPECIFIC = [
  // 'customer' is reserved for a VERIFIED placed Order — never a status word. A
  // "Hot (Clients)" / "Orders In Progress" label is just warmth/segment, so it
  // maps to a pre-customer stage and KEEPS its tag; real customer promotion is
  // owner-approved on order placement (controllers/orders.js).
  { re: /hot\s*\(\s*client/,          stage: 'contacted', tag: 'hot' },
  { re: /won\s*order/,                stage: 'won',       tag: 'won' },
  { re: /orders?\s*in\s*progress/,    stage: 'quoting',   tag: 'in-progress' },
  { re: /warm\s*\(\s*lead/,           stage: 'contacted', tag: 'warm' },
  { re: /room\s*temp/,                stage: 'contacted', tag: 'room-temp' },
  { re: /cold\s*\(\s*prospect/,       stage: 'lead',      tag: 'cold' },
  { re: /lost\s*order/,               stage: 'dormant',   tag: 'lost' },
  { re: /meta\s*ad/,                  stage: 'lead',      tag: 'meta-ad' },
];

// GENERIC: loose single temperature/segment words the owner's sheets use. These
// provide a TAG always, but their STAGE is only used as a LAST resort in
// mapStatus (after the won/order/lost/quoting vocabulary), so a free-text status
// like "won - was hot" is read as 'won', not 'quoting'. The bare "lost" mirrors
// the Notion "Lost Orders" handling (Google "CRM" sheet's LOST tab → dormant).
const STATUS_MAP_GENERIC = [
  { re: /\blost\b/,                                       stage: 'dormant',   tag: 'lost' },
  { re: /\bhot\b/,                                        stage: 'quoting',   tag: 'hot' },
  { re: /\bwarm\b/,                                       stage: 'contacted', tag: 'warm' },
  { re: /\b(lukewarm|luke ?warm|opportunit(?:y|ies)|opp)\b/, stage: 'contacted', tag: 'room-temp' },
  { re: /\bcold\b/,                                       stage: 'lead',      tag: 'cold' },
];

// Search a map for the first non-negated-suppressed hit. 'lost'/'cold' end-states
// survive a negated phrase (real kept statuses); positive segments don't.
function matchStatusMap(map, v, negated) {
  for (const t of map) {
    if (t.re.test(v)) {
      if (negated && !['lost', 'cold'].includes(t.tag)) continue;
      return t;
    }
  }
  return null;
}

// Pull the segment/temperature classification (if any) out of a raw status, used
// for TAGGING (mapTrackerRow). Specific Notion values win; otherwise a generic
// temperature word. Returns { stage, tag } or null. (mapStatus decides the final
// STAGE differently — generic-temperature stage is a last resort there.)
function statusTemperature(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  const negated = isNegatedStatus(v);
  return matchStatusMap(STATUS_MAP_SPECIFIC, v, negated)
      || matchStatusMap(STATUS_MAP_GENERIC, v, negated);
}

// Map the optional "Engagement Level" (Notion: High/Medium/Low/Inactive) to a
// tag so the segment is captured. '' for blank/unknown.
function engagementTag(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  if (v.includes('high'))     return 'eng-high';
  if (v.includes('medium') || v.includes('med')) return 'eng-medium';
  if (v.includes('low'))      return 'eng-low';
  if (v.includes('inactive')) return 'eng-inactive';
  return '';
}

// Does the "Order Status" multi-select carry a REAL order state (anything beyond
// a bare Lead/Lost)? Values: Completed / Paid / In Transit / Invoice Sent /
// Quoting / Mockups in Progress / Lead / Lost. A real order state ⇒ this company
// is a customer (promote up). Lead/Lost-only ⇒ no order implied.
function orderStatusImpliesOrder(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return false;
  return /(complete|paid|in transit|invoice|quoting|mockup|production|shipped|fulfilled|delivered)/.test(v);
}

// The single negation predicate shared by mapStatus + statusTemperature: a
// status carrying "won't / wont / didn't / not / no / never / cancel / no
// longer" is NOT a live positive, even if it also contains "won"/"order"/"hot".
function isNegatedStatus(v) {
  return /\b(wo?n['’]?t|did(?:n['’]?t| not)|cancel(?:l?ed|ling)?|no longer|never|not interested|no\b)/.test(String(v || ''));
}

// Status → stage. The vocabulary is loose ("Visited", "hot lead", "Stage:
// quoting"). We map the clear ones; anything unrecognized falls back to 'lead'
// (NOT 'contacted') so we never fabricate a touch that didn't happen. Only a
// positive-contact keyword promotes to 'contacted'. The RAW status text is
// preserved in a log, and any temperature is captured as a tag by the caller.
function mapStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  const negated = isNegatedStatus(v);

  // 1) The owner's EXACT CRM Status values take precedence and short-circuit
  //    (so "Hot (Clients)" → contacted, never misread as "won" via "client";
  //    "Cold (Prospects)" → lead; "Lost Orders" → dormant). These are decided
  //    first because they're unambiguous; the looser free-text vocabulary below
  //    can't override them. None of them yield 'customer' (a placed-order signal).
  const specific = matchStatusMap(STATUS_MAP_SPECIFIC, v, negated);
  if (specific) return specific.stage;

  // 2) Hard dead/lost (field-tracker free-text): a not-interested / DNC / no-answer
  //    status, or a negated sale ("won't reorder", "cancelled order"), is lost.
  //    Checked before WON so a negative line can't be misread as a sale. (A bare
  //    "lost"/"lost the deal" is handled by the generic map in step 5 → dormant.)
  if (statusImpliesDead(v) || (negated && /(won|order|reorder|buy|interest)/.test(v))) return 'lost';
  // 3) Positive customer/sale vocab — "won"/"reorder" signal a closed sale.
  if (!negated && (v.includes('won') || v.includes('reorder'))) return 'won';
  // "customer"/"client"/"active" signal an existing relationship → 'contacted'.
  // NOT 'customer': a status WORD never makes a customer — that's reserved for a
  // verified placed Order (promoted by the controller, owner-approved).
  if (!negated && (v.includes('customer') || v.includes('client') || v.includes('active'))) return 'contacted';
  if (v.includes('quot')) return 'quoting';
  if (v.includes('sampl')) return 'sampling';
  if (!negated && v.includes('order')) return 'won';
  // 4) Positive-contact keywords.
  if (POSITIVE_CONTACT.some((k) => v.includes(k))) return 'contacted';
  if (v.includes('call') || v.includes('email') || v.includes('text') || v.includes('messag')) {
    // Bare "call back" / "email them" is a TODO, not proof of contact → lead.
    // Only past-tense / completed forms count as contacted.
    if (/called|emailed|texted|messaged|reached/.test(v)) return 'contacted';
    return 'lead';
  }
  // 5) Generic single temperature/segment word as a LAST resort for stage (the
  //    sheets' bare "hot"/"warm"/"cold"/"lost"). After the sale/order vocabulary
  //    above, so "won - was hot" already returned 'won' and only a status that is
  //    *just* a temperature word lands here.
  const generic = matchStatusMap(STATUS_MAP_GENERIC, v, negated);
  if (generic) return generic.stage;

  return 'lead';
}

// Pull an M/D (or M/D/Y) date out of free text like "texted 6/9",
// "call 7/7 between 9-2:30", "reply email 6/11". Returns
//   { date: Date|null, ambiguous: bool, raw }
// date is UTC noon (dodges TZ edge-cases). Month/day with no year → assumes
// `year`. `ambiguous` is true when there was date-looking text we couldn't
// parse into a valid calendar date (so the caller can surface it instead of
// silently nulling).
function extractDateInfo(text, year) {
  const raw = text == null ? '' : String(text);
  if (!raw.trim()) return { date: null, ambiguous: false, raw };

  // ISO first (YYYY-MM-DD) — the shape Notion and most sheet exports use. Build
  // at UTC noon (same convention as the M/D path) so the calendar day never
  // shifts across the server's timezone and ET day-bucketing in /today stays
  // correct. A trailing "T..." time component (full ISO timestamp) is ignored —
  // we only want the calendar day.
  const iso = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const y = parseInt(iso[1], 10);
    const mo = parseInt(iso[2], 10);
    const da = parseInt(iso[3], 10);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      const d = new Date(Date.UTC(y, mo - 1, da, 12, 0, 0));
      if (!isNaN(d.getTime()) && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da) {
        return { date: d, ambiguous: false, raw };
      }
    }
    return { date: null, ambiguous: true, raw };
  }

  const m = raw.match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/);
  if (!m) {
    // No M/D we can trust. If the cell reads like an intended date the owner
    // wrote in prose ("next week", "early next month", "Monday", "6-9"), flag it
    // as ambiguous so the result surfaces it instead of silently dropping it.
    const RELATIVE = /(week|month|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|next|early|late|end of|beginning of|mid|days?|eod|am|pm)/i;
    const looksDateish = RELATIVE.test(raw) || /\b\d{1,2}\s*[-]\s*\d{1,2}\b/.test(raw);
    return { date: null, ambiguous: looksDateish, raw };
  }
  const mo = parseInt(m[1], 10);
  const da = parseInt(m[2], 10);
  let yr = m[3] ? parseInt(m[3], 10) : year;
  if (m[3] && yr < 100) yr += 2000;             // "26" → 2026
  if (!(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31)) {
    return { date: null, ambiguous: true, raw };
  }
  // Build at UTC noon so the calendar date never shifts across server TZ.
  const d = new Date(Date.UTC(yr, mo - 1, da, 12, 0, 0));
  if (isNaN(d.getTime())) return { date: null, ambiguous: true, raw };
  // Guard against rollover (e.g. 2/31 → Mar 3).
  if (d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
    return { date: null, ambiguous: true, raw };
  }
  return { date: d, ambiguous: false, raw };
}

// Back-compat thin wrapper — returns just the Date (or null). Kept because
// existing callers/tests import extractDate.
function extractDate(text, year) {
  return extractDateInfo(text, year).date;
}

// Try to guess a role from a contact blob like "Ivana Lucas - branch manager"
// or "Steven - buyer" or "Lane Shelton - manager (HQ in charge of merch)".
function guessRole(blob) {
  const v = String(blob || '').toLowerCase();
  const roles = ['owner', 'gm', 'general manager', 'manager', 'purchasing manager',
    'purchaser', 'buyer', 'buying manager', 'inventory manager', 'marketing',
    'budtender', 'shift lead', 'shift leader', 'head budtender', 'assistant manager',
    'team lead', 'security'];
  for (const r of roles) {
    if (v.includes(r)) return r;
  }
  return '';
}

// First name out of a contact blob: take text before the first delimiter
// (comma, dash, paren) so "Diana, manager (Markony Owner)" → "Diana".
function firstContactName(blob) {
  const v = String(blob || '').trim();
  if (!v) return '';
  const cut = v.split(/[,(\-–]/)[0].trim();
  return cut || v;
}

// All emails in a blob (handles comma / semicolon / whitespace / "and"
// separators), lowercased, de-duped, order-preserving.
function allEmails(blob) {
  const v = String(blob || '');
  const matches = v.match(/[^\s,;()<>]+@[^\s,;()<>]+\.[a-z]{2,}/gi) || [];
  const out = [];
  const seen = new Set();
  for (const e of matches) {
    const lc = e.toLowerCase().replace(/[.,;]+$/, '');
    if (!seen.has(lc)) { seen.add(lc); out.push(lc); }
  }
  return out;
}

// First email — kept for back-compat with existing tests.
function firstEmail(blob) {
  return allEmails(blob)[0] || '';
}

// All "real" phone numbers in a blob. A phone is real only if it has ≥7 digits.
// Splits on comma / semicolon / slash / "and" / newline so multi-number cells
// ("(201) 555-1212, c: 555-1313") become multiple contacts. Returns the cleaned
// original tokens (display form preserved), de-duped by digits.
function allPhones(blob) {
  const v = String(blob || '');
  if (!v.trim()) return [];
  const tokens = v.split(/[,;\n]|\band\b|\/(?!\d)/i);
  const out = [];
  const seen = new Set();
  for (const tRaw of tokens) {
    const t = tRaw.trim();
    const digits = t.replace(/\D/g, '');
    if (digits.length >= 7) {
      // collapse to a canonical 10-digit (drop a leading US '1') for dedup
      const canon = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
      if (!seen.has(canon)) { seen.add(canon); out.push(t); }
    }
  }
  return out;
}

// A phone string is "real" only if it has enough digits — back-compat single.
function cleanPhone(blob) {
  return allPhones(blob)[0] || '';
}

// Digits-only canonical form of a phone for cross-record matching (drops a
// leading US country code). '' for nothing usable.
function normPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
}

// Lowercased trimmed email for matching. '' when not an email.
function normEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(v) ? v : '';
}

// Build the list of contacts from the row. Pairs up names/phones/emails when the
// counts line up (parallel multi-value cells); otherwise attaches every
// phone/email to the primary named contact and emits extra contacts for leftover
// numbers/emails so nothing is dropped.
function buildContacts(contactBlob, phoneRaw, emailRaw) {
  const names = String(contactBlob || '')
    .split(/[,;\n]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const phones = allPhones(phoneRaw);
  const emails = allEmails(emailRaw);

  const contacts = [];

  if (names.length > 1 && (names.length === phones.length || names.length === emails.length)) {
    // Parallel columns: zip them.
    names.forEach((nm, idx) => {
      contacts.push({
        name:  firstContactName(nm),
        role:  guessRole(nm),
        phone: phones[idx] || '',
        email: emails[idx] || '',
      });
    });
    return contacts.filter((c) => c.name || c.phone || c.email);
  }

  // Primary contact carries the first name + first phone + first email.
  const primaryName = firstContactName(names[0] || '');
  const primaryRole = guessRole(names[0] || contactBlob || '');
  if (primaryName || phones[0] || emails[0] || primaryRole) {
    contacts.push({
      name:  primaryName,
      role:  primaryRole,
      phone: phones[0] || '',
      email: emails[0] || '',
    });
  }
  // Any EXTRA phones/emails beyond the first become their own bare contacts so
  // a second number/address is never lost.
  for (let i = 1; i < phones.length; i++) contacts.push({ name: '', role: '', phone: phones[i], email: '' });
  for (let i = 1; i < emails.length; i++) contacts.push({ name: '', role: '', phone: '', email: emails[i] });

  return contacts.filter((c) => c.name || c.phone || c.email);
}

// Map ONE tracker row (object keyed by canonical column name) into a normalized
// CRM patch object. Pure — does no merging with any existing DB record (the
// controller decides how to merge).
//
// Returns (when usable):
//   {
//     companyName, companyKey, matchKey, area, interestType,
//     stage|null, phone, email,
//     contacts: [{ name, role, phone, email }],
//     lastContact: Date|null, nextFollowUp: Date|null,
//     ambiguousDates: [string],          // date cells we couldn't parse
//     logs: [{ text, kind }],            // (single structured import line + raw)
//     rowIdentity: string,               // stable id for log de-dup
//     _skip: bool, _skipReason: 'no-company'|'dead'|null
//   }
function mapTrackerRow(rowObj, opts = {}) {
  // Default the assumed year to the CURRENT (Eastern) year, not a hardcoded one.
  const year = opts.year || new Date().getUTCFullYear();
  const get = (k) => (rowObj && rowObj[k] != null ? String(rowObj[k]).trim() : '');

  // Identity: prefer Company Name, but fall back to Client Name (the Google
  // sheet's primary column) so a row with only a person/client name still keys.
  const companyName = get('companyName');
  const clientName  = get('clientName');
  const companyKey  = deriveCompanyKey(companyName, clientName);
  if (!companyKey) return { _skip: true, _skipReason: 'no-company', logs: [] };

  const contactBlob = get('contact');
  const phoneRaw    = get('phone');
  const emailRaw    = get('email');
  const area        = get('area');
  const address     = get('address');     // exact street address (new)
  const interestRaw = get('interested');
  const statusRaw   = get('status');
  const lastRaw     = get('lastContact');
  const nextRaw     = get('nextContact');
  const actionRaw   = get('nextAction');
  const notesRaw    = get('notes');
  const orderNumRaw = get('orderNumber');  // free-text HINT only (not a verified order)
  const orderStatRaw = get('orderStatus'); // Notion "Order Status" multi-select
  const dealValueRaw = get('dealValue');   // Notion "Deal Value" ($ number)
  const sourceRaw    = get('sourceField'); // Notion "Source" (lead origin)
  const engageRaw    = get('engagement');  // Notion "Engagement Level"

  const phones = allPhones(phoneRaw);
  const emails = allEmails(emailRaw);
  const phone = phones[0] || '';
  const email = emails[0] || '';

  const contacts = buildContacts(contactBlob, phoneRaw, emailRaw);

  // Which source is this? CRM-DB sources (the owner's Notion CRM and his Google
  // "CRM" sheet) span the WHOLE funnel and intentionally include cold prospects
  // and lost/past projects he re-contacts — those must be KEPT (only a missing
  // company name skips). The field-visit tracker is a prospecting list where a
  // dead/no-answer row with no order and no follow-up is genuine dead-weight that
  // may skip. An unspecified/generic format defaults to the tracker's dead-skip
  // (back-compat: a bare mapTrackerRow call, and generic prospecting CSVs, behave
  // like the tracker). The two real CRM-DB formats are recognized by their headers.
  const fmt = opts.format || labelToFormat(opts.sourceLabel);
  const isCrmDbSource = fmt === 'notion' || fmt === 'google-sheet';

  // ORDER HINT (NOT a customer promotion): a free-text "Order Number" cell, or an
  // "Order Status" naming a real order state, SUGGESTS this company has ordered —
  // but it's just text, with no verified Order doc behind it. So it does NOT make
  // the import emit stage 'customer'. The importer NEVER outputs 'customer';
  // customer is earned only by a real PLACED Order, promoted owner-side by the
  // controller (which checks actual placed Orders by companyKey). We keep the
  // signal as a tag so it's surfaced, and the controller resolves it for real.
  const hasOrderNumber = !!orderNumRaw || orderStatusImpliesOrder(orderStatRaw);
  const stage = mapStatus(statusRaw);

  // Tags: the status segment (hot/warm/room-temp/cold/lost/in-progress/won/
  // meta-ad) + engagement level — captured so nothing in the warmth/segment is
  // lost when we translate to a stage. An order hint adds an 'order-ref' tag so
  // the free-text order number isn't lost (without forcing customer).
  const tags = [];
  const seg = statusTemperature(statusRaw);
  if (seg && seg.tag) tags.push(seg.tag);
  if (hasOrderNumber) tags.push('order-ref');
  const engTag = engagementTag(engageRaw);
  if (engTag) tags.push(engTag);

  // Deal value ($) — parse a number out of "$2,500" / "2500" / "2.5k". 0/blank
  // ⇒ unset (the controller only fills a blank, never overwrites an owner value).
  const dealValue = parseMoney(dealValueRaw);
  // Lead origin (Notion "Source" — e.g. "Meta Ad", "Referral"). Distinct from the
  // Client's provenance `source` field; surfaced in the import line so it's kept.
  const leadSource = sourceRaw;

  const lastInfo     = extractDateInfo(lastRaw, year);
  const nextInfo     = extractDateInfo(nextRaw, year);
  const lastContact  = lastInfo.date;
  const nextFollowUp = nextInfo.date;

  const ambiguousDates = [];
  if (lastInfo.ambiguous) ambiguousDates.push(`Last contact: "${lastRaw}"`);
  if (nextInfo.ambiguous) ambiguousDates.push(`Next contact: "${nextRaw}"`);

  // Dead-row decision. CRM-DB sources (Notion / Google CRM) NEVER dead-skip:
  // cold prospects and lost/past projects are real kept records. Every other
  // source (field tracker, or an unspecified/generic import) applies the tracker's
  // dead-skip: dead/non-contact status AND no future follow-up, OR a hard
  // "interested? = no". An order ALWAYS keeps the row.
  const hasFutureFollow = !!nextFollowUp; // a parsed next date is a real plan
  const dead = !isCrmDbSource && !hasOrderNumber && (interestIsNo(interestRaw)
    || (statusImpliesDead(statusRaw) && !hasFutureFollow));

  // ── Logs: ONE structured import line (+ the always-useful free-text notes /
  // next-action). The per-field Status/Last/Next metadata is folded into the
  // single line so a re-import doesn't pile up near-duplicate rows.
  const summaryBits = [];
  if (statusRaw)   summaryBits.push(`status "${statusRaw}"`);
  if (orderStatRaw) summaryBits.push(`order status "${orderStatRaw}"`);
  if (leadSource)  summaryBits.push(`source "${leadSource}"`);
  if (lastRaw)     summaryBits.push(`last "${lastRaw}"`);
  if (nextRaw)     summaryBits.push(`next "${nextRaw}"`);
  if (phoneRaw && !phone) summaryBits.push(`phone "${phoneRaw}" (unparsed)`);
  const summary = summaryBits.length ? ` — ${summaryBits.join(', ')}` : '';

  // Source label in the import line — defaults to "field tracker" (so the legacy
  // import reads the same), but a multi-format pull passes the detected source
  // ("Notion CRM", "CRM sheet"). The dedupKey is ALWAYS `import:<companyKey>` so
  // re-importing the same company never piles up a second import line, no matter
  // which source it came from.
  const sourceLabel = opts.sourceLabel || 'field tracker';
  const logs = [
    { kind: 'import', text: `Imported from ${sourceLabel}${summary}`, dedupKey: `import:${companyKey}` },
  ];
  if (actionRaw) logs.push({ kind: 'next-action', text: actionRaw, dedupKey: `next-action:${companyKey}:${actionRaw}` });
  if (notesRaw)  logs.push({ kind: 'note', text: notesRaw, dedupKey: `note:${companyKey}:${notesRaw}` });

  return {
    companyName,
    clientName,             // person/client name (Google sheet) — '' if absent
    companyKey,
    matchKey: matchKey(companyName, clientName),
    area,
    address,                // exact street address — '' if absent
    interestType: mapInterest(interestRaw),
    stage,                  // status-derived stage; may be null — NEVER 'customer'
    tags,                   // segment/temperature/engagement tags — may be []
    dealValue,              // parsed $ deal value (0 ⇒ unset)
    leadSource,             // lead origin (Notion "Source") — '' if absent
    provenance: provenanceFor(fmt), // record origin for Client.source ('notion'/…)
    orderNumber: orderNumRaw, // raw order number from the row (free-text hint)
    hasOrderNumber,         // true ⇒ row carries an order # / order-state HINT (not customer)
    phone,                  // top-level phone (may be '')
    email,                  // top-level/primary email (may be '')
    contacts,               // array of {name,role,phone,email}
    lastContact,            // Date or null
    nextFollowUp,           // Date or null
    ambiguousDates,         // date cells we couldn't parse (surfaced, not dropped)
    logs,                   // structured import line(s)
    rowIdentity: companyKey,
    statusRaw,              // kept for the caller's skip breakdown / debugging
    _skip: dead,
    _skipReason: dead ? 'dead' : null,
  };
}

// Human label for the import-line per detected format.
const FORMAT_LABEL = {
  notion: 'Notion CRM',
  'google-sheet': 'CRM sheet',
  'field-tracker': 'field tracker',
  csv: 'CSV',
  unknown: 'CSV',
};
function formatLabel(format) {
  return FORMAT_LABEL[format] || 'CSV';
}

// Convert a parsed CSV (array of arrays) into an array of canonical row objects,
// using the located header. Skips the title + header rows and blank rows.
// Returns just the row objects (back-compat). The detected format rides on a
// non-enumerable-ish convenience: use rowsToObjectsWithMeta when you need it.
function rowsToObjects(rows) {
  return rowsToObjectsWithMeta(rows).rows;
}

// Same as rowsToObjects but also returns { format, columns, headerIndex } so the
// caller can label the import line by source. Pure.
function rowsToObjectsWithMeta(rows) {
  const { headerIndex, columns, format } = locateHeader(rows);
  if (headerIndex < 0) return { rows: [], format: 'unknown', columns: {}, headerIndex: -1 };
  const out = [];
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const cells = rows[r] || [];
    // Skip fully-empty rows.
    if (!cells.some((c) => String(c || '').trim() !== '')) continue;
    const obj = {};
    for (const canon of Object.keys(columns)) {
      obj[canon] = cells[columns[canon]] != null ? cells[columns[canon]] : '';
    }
    out.push(obj);
  }
  return { rows: out, format, columns, headerIndex };
}

// Top-level convenience: raw CSV text → array of CRM patches (includes skipped
// rows so the caller can categorize; filter on _skip if you only want keepers).
// Threads the detected source label into each mapped row's import log line.
function parseTrackerCsv(text, opts = {}) {
  const rows = parseCsv(text);
  const { rows: objs, format } = rowsToObjectsWithMeta(rows);
  const sourceLabel = opts.sourceLabel || formatLabel(format);
  return objs.map((o) => mapTrackerRow(o, { ...opts, format, sourceLabel }));
}

module.exports = {
  deriveCompanyKey,
  matchKey,
  parseCsv,
  locateHeader,
  detectFormat,
  canonHeader,
  formatLabel,
  rowsToObjects,
  rowsToObjectsWithMeta,
  mapTrackerRow,
  parseTrackerCsv,
  // exported for testing / reuse
  normHeader,
  mapInterest,
  interestIsNo,
  mapStatus,
  statusTemperature,
  engagementTag,
  orderStatusImpliesOrder,
  parseMoney,
  labelToFormat,
  provenanceFor,
  isNegatedStatus,
  statusImpliesDead,
  extractDate,
  extractDateInfo,
  firstEmail,
  allEmails,
  firstContactName,
  cleanPhone,
  allPhones,
  normPhone,
  normEmail,
  buildContacts,
  guessRole,
};
