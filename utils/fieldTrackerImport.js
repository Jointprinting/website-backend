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

// The owner's exact headers (row 2 of the tracker). Used to align columns even
// if order shifts. Matching is case-insensitive and whitespace-insensitive.
const HEADER_ALIASES = {
  companyname:   'companyName',
  ownercontact:  'contact',
  'owner/contact': 'contact',
  phone:         'phone',
  email:         'email',
  area:          'area',
  interested:    'interested',
  'interested?': 'interested',
  status:        'status',
  lastcontact:   'lastContact',
  nextcontact:   'nextContact',
  nextaction:    'nextAction',
  notes:         'notes',
};

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '');
}

// Given a parsed CSV (array of arrays), find the header row and return
// { headerIndex, columns } where columns maps canonical-name → column index.
// The tracker has a title row ("Field Visit Tracker,,,..") above the headers,
// so we scan for the row that actually contains "Company Name".
function locateHeader(rows) {
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] || [];
    const norm = cells.map(normHeader);
    if (norm.includes('companyname')) {
      const columns = {};
      cells.forEach((cell, idx) => {
        const key = normHeader(cell);
        const canon = HEADER_ALIASES[key] || HEADER_ALIASES[key.replace(/[^a-z0-9/]/g, '')];
        if (canon && !(canon in columns)) columns[canon] = idx;
      });
      return { headerIndex: r, columns };
    }
  }
  return { headerIndex: -1, columns: {} };
}

// ── Field mapping ─────────────────────────────────────────────────────────────

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

// Status → stage. The tracker's vocabulary is loose ("Visited", etc.). We map
// the clear ones; anything unrecognized falls back to 'lead' (NOT 'contacted')
// so we never fabricate a touch that didn't happen. Only a positive-contact
// keyword promotes to 'contacted'. The RAW status text is preserved in a log.
function mapStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  // Negation guard: a status with "won't / wont / didn't / not / no / never /
  // cancel" is NOT a sale even if it contains "won"/"order"/"reorder"
  // ("won't reorder", "no order", "cancelled order"). Treat it as lost.
  const negated = /\b(wo?n['’]?t|did(?:n['’]?t| not)|cancel(?:l?ed|ling)?|no longer|never|not interested|no\b)/.test(v);
  // Check LOST/DEAD before WON so a negative line can't be misread as a sale.
  if (v.includes('lost') || statusImpliesDead(v) || (negated && /(won|order|reorder|buy|interest)/.test(v))) return 'lost';
  if (!negated && (v.includes('won') || v.includes('customer') || v.includes('reorder'))) return 'won';
  if (v.includes('quot')) return 'quoting';
  if (v.includes('sampl')) return 'sampling';
  if (!negated && v.includes('order')) return 'won';
  if (POSITIVE_CONTACT.some((k) => v.includes(k))) return 'contacted';
  if (v.includes('call') || v.includes('email') || v.includes('text') || v.includes('messag')) {
    // Bare "call back" / "email them" is a TODO, not proof of contact → lead.
    // Only past-tense / completed forms count as contacted.
    if (/called|emailed|texted|messaged|reached/.test(v)) return 'contacted';
    return 'lead';
  }
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

  const companyName = get('companyName');
  const companyKey  = deriveCompanyKey(companyName, '');
  if (!companyKey) return { _skip: true, _skipReason: 'no-company', logs: [] };

  const contactBlob = get('contact');
  const phoneRaw    = get('phone');
  const emailRaw    = get('email');
  const area        = get('area');
  const interestRaw = get('interested');
  const statusRaw   = get('status');
  const lastRaw     = get('lastContact');
  const nextRaw     = get('nextContact');
  const actionRaw   = get('nextAction');
  const notesRaw    = get('notes');

  const phones = allPhones(phoneRaw);
  const emails = allEmails(emailRaw);
  const phone = phones[0] || '';
  const email = emails[0] || '';

  const contacts = buildContacts(contactBlob, phoneRaw, emailRaw);

  const stage        = mapStatus(statusRaw);
  const lastInfo     = extractDateInfo(lastRaw, year);
  const nextInfo     = extractDateInfo(nextRaw, year);
  const lastContact  = lastInfo.date;
  const nextFollowUp = nextInfo.date;

  const ambiguousDates = [];
  if (lastInfo.ambiguous) ambiguousDates.push(`Last contact: "${lastRaw}"`);
  if (nextInfo.ambiguous) ambiguousDates.push(`Next contact: "${nextRaw}"`);

  // Dead-row decision: dead/non-contact status AND no FUTURE follow-up; OR a
  // hard "interested? = no". (A dead status WITH a real future follow-up is kept
  // — the owner deliberately scheduled it.)
  const hasFutureFollow = !!nextFollowUp; // a parsed next date is a real plan
  const dead = interestIsNo(interestRaw)
    || (statusImpliesDead(statusRaw) && !hasFutureFollow);

  // ── Logs: ONE structured import line (+ the always-useful free-text notes /
  // next-action). The per-field Status/Last/Next metadata is folded into the
  // single line so a re-import doesn't pile up near-duplicate rows.
  const summaryBits = [];
  if (statusRaw) summaryBits.push(`status "${statusRaw}"`);
  if (lastRaw)   summaryBits.push(`last "${lastRaw}"`);
  if (nextRaw)   summaryBits.push(`next "${nextRaw}"`);
  if (phoneRaw && !phone) summaryBits.push(`phone "${phoneRaw}" (unparsed)`);
  const summary = summaryBits.length ? ` — ${summaryBits.join(', ')}` : '';

  const logs = [
    { kind: 'import', text: `Imported from field tracker${summary}`, dedupKey: `import:${companyKey}` },
  ];
  if (actionRaw) logs.push({ kind: 'next-action', text: actionRaw, dedupKey: `next-action:${companyKey}:${actionRaw}` });
  if (notesRaw)  logs.push({ kind: 'note', text: notesRaw, dedupKey: `note:${companyKey}:${notesRaw}` });

  return {
    companyName,
    companyKey,
    matchKey: matchKey(companyName, ''),
    area,
    interestType: mapInterest(interestRaw),
    stage,                  // may be null
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

// Convert a parsed CSV (array of arrays) into an array of canonical row objects,
// using the located header. Skips the title + header rows and blank rows.
function rowsToObjects(rows) {
  const { headerIndex, columns } = locateHeader(rows);
  if (headerIndex < 0) return [];
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
  return out;
}

// Top-level convenience: raw CSV text → array of CRM patches (includes skipped
// rows so the caller can categorize; filter on _skip if you only want keepers).
function parseTrackerCsv(text, opts = {}) {
  const rows = parseCsv(text);
  const objs = rowsToObjects(rows);
  return objs.map((o) => mapTrackerRow(o, opts));
}

module.exports = {
  deriveCompanyKey,
  matchKey,
  parseCsv,
  locateHeader,
  rowsToObjects,
  mapTrackerRow,
  parseTrackerCsv,
  // exported for testing / reuse
  mapInterest,
  interestIsNo,
  mapStatus,
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
