// utils/fieldTrackerImport.js
//
// Pure-logic helpers for the CRM "field tracker" import:
//   • parseCsv(text)         — a robust RFC-4180-ish CSV parser (quoted fields,
//                              embedded commas/newlines, "" escaped quotes).
//   • mapTrackerRow(row)     — map one owner field-tracker row → CRM patch.
//
// No DB / no Express here so it can be unit-tested directly against the real
// CSV. The companyKey normalization mirrors models/Order.js#deriveCompanyKey
// EXACTLY so CRM records line up with Orders by key.

// Same normalization the rest of the system uses (models/Order.js). Kept inline
// (not imported) so this module stays dependency-free and testable in isolation,
// but it MUST stay byte-for-byte identical to deriveCompanyKey.
function deriveCompanyKey(companyName, clientName) {
  const raw = (companyName || clientName || '').toString();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
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

// Status → stage. The tracker's vocabulary is loose ("Visited", etc.). We map
// the common ones and fall back to 'contacted' for anything non-empty that
// clearly implies an in-person touch; truly unknown/blank → null (caller leaves
// stage at its default). The RAW status text is always preserved in a log note.
function mapStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v.includes('won') || v.includes('order') || v.includes('customer')) return 'won';
  if (v.includes('lost') || v.includes('dead') || v.includes('not interested')) return 'lost';
  if (v.includes('quot')) return 'quoting';
  if (v.includes('sampl')) return 'sampling';
  if (v.includes('visit') || v.includes('contacted') || v.includes('pitch')
      || v.includes('call') || v.includes('email') || v.includes('text')
      || v.includes('messag') || v.includes('spoke')) return 'contacted';
  return 'contacted';
}

// Pull an M/D (or M/D/Y) date out of free text like "texted 6/9",
// "call 7/7 between 9-2:30", "reply email 6/11". Returns a JS Date (UTC noon to
// dodge TZ edge-cases) or null. Month/day with no year → assumes `year`.
function extractDate(text, year) {
  if (text == null) return null;
  const str = String(text);
  const m = str.match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/);
  if (!m) return null;
  const mo = parseInt(m[1], 10);
  const da = parseInt(m[2], 10);
  let yr = m[3] ? parseInt(m[3], 10) : year;
  if (m[3] && yr < 100) yr += 2000;             // "26" → 2026
  if (!(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31)) return null;
  // Build at UTC noon so the calendar date never shifts across server TZ.
  const d = new Date(Date.UTC(yr, mo - 1, da, 12, 0, 0));
  if (isNaN(d.getTime())) return null;
  // Guard against rollover (e.g. 2/31 → Mar 3).
  if (d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return null;
  return d;
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

// First email out of a possibly comma-separated list, stripping trailing
// parentheticals like "(on paper)".
function firstEmail(blob) {
  const v = String(blob || '').trim();
  if (!v) return '';
  const first = v.split(',')[0].trim();
  const m = first.match(/[^\s,()]+@[^\s,()]+\.[^\s,()]+/);
  return m ? m[0].toLowerCase() : '';
}

// A phone string is "real" only if it has enough digits. Values like "on paper"
// or "number doesnt work" are dropped (kept in a log note by the caller).
function cleanPhone(blob) {
  const v = String(blob || '').trim();
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 ? v : '';
}

// Map ONE tracker row (object keyed by canonical column name, OR an array +
// columns map) into a normalized CRM patch object. Pure — does no merging with
// any existing DB record (the controller decides how to merge).
//
// Returns:
//   {
//     companyName, companyKey, area, interestType,
//     stage|null, phone, email,
//     contact: { name, role, phone, email } | null,
//     lastContact: Date|null, nextFollowUp: Date|null,
//     logs: [{ text, kind }],            // notes to APPEND (never overwrite)
//     _skip: bool                        // true when there's no usable company
//   }
function mapTrackerRow(rowObj, opts = {}) {
  const year = opts.year || 2026;
  const get = (k) => (rowObj && rowObj[k] != null ? String(rowObj[k]).trim() : '');

  const companyName = get('companyName');
  const companyKey  = deriveCompanyKey(companyName, '');
  if (!companyKey) return { _skip: true, logs: [] };

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

  const phone = cleanPhone(phoneRaw);
  const email = firstEmail(emailRaw);

  let contact = null;
  if (contactBlob || phone || email) {
    contact = {
      name:  firstContactName(contactBlob),
      role:  guessRole(contactBlob),
      phone: phone || '',
      email: email || '',
    };
    // If the contact blob held nothing usable but we still have a phone/email,
    // keep the contact (name may be '').
    if (!contact.name && !contact.role && !contact.phone && !contact.email) contact = null;
  }

  const stage        = mapStatus(statusRaw);
  const lastContact  = extractDate(lastRaw, year);
  const nextFollowUp = extractDate(nextRaw, year);

  const logs = [];
  if (statusRaw)  logs.push({ kind: 'import',      text: `Status: ${statusRaw}` });
  if (lastRaw)    logs.push({ kind: 'last-contact', text: `Last contact: ${lastRaw}` });
  if (nextRaw)    logs.push({ kind: 'next-contact', text: `Next contact: ${nextRaw}` });
  if (actionRaw)  logs.push({ kind: 'next-action',  text: actionRaw });
  if (notesRaw)   logs.push({ kind: 'note',         text: notesRaw });
  // Preserve a phone we couldn't validate, rather than silently dropping it.
  if (phoneRaw && !phone) logs.push({ kind: 'note', text: `Phone (unparsed): ${phoneRaw}` });

  return {
    companyName,
    companyKey,
    area,
    interestType: mapInterest(interestRaw),
    stage,                  // may be null
    phone,                  // top-level phone (may be '')
    email,                  // top-level/primary email (may be '')
    contact,                // single primary contact or null
    lastContact,            // Date or null
    nextFollowUp,           // Date or null
    logs,                   // notes to append
    _skip: false,
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

// Top-level convenience: raw CSV text → array of CRM patches (skips unusable).
function parseTrackerCsv(text, opts = {}) {
  const rows = parseCsv(text);
  const objs = rowsToObjects(rows);
  return objs.map((o) => mapTrackerRow(o, opts)).filter((m) => !m._skip);
}

module.exports = {
  deriveCompanyKey,
  parseCsv,
  locateHeader,
  rowsToObjects,
  mapTrackerRow,
  parseTrackerCsv,
  // exported for testing
  mapInterest,
  mapStatus,
  extractDate,
  firstEmail,
  firstContactName,
  cleanPhone,
  guessRole,
};
