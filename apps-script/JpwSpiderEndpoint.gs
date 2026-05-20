// JpwSpiderEndpoint.gs
//
// Paste this entire file into Apps Script inside your Spider sheet:
//   Extensions → Apps Script → replace contents of Code.gs.
//
// Then change SHARED_SECRET below, Deploy → New deployment → Web app,
// "Execute as: Me", "Who has access: Anyone with the link". Copy the Web app
// URL and put it (plus the secret) in the backend env vars listed in
// docs/JPW_SPIDER_SETUP.md.
//
// Behavior:
//   - POST JSON { secret, target_tab, rows: [...] } → appends rows to the
//     given tab in this sheet. Creates the tab + writes a header row the
//     first time it sees a tab that doesn't exist.
//   - Dedupes by `dedupe_key` stored in a hidden column; re-pushing the
//     same key is a no-op so the sheet doesn't fill with duplicates.
//   - Rejects requests whose `secret` doesn't match SHARED_SECRET.

// ── CONFIG ──────────────────────────────────────────────────────────────────
const SHARED_SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
const DEDUPE_COLUMN_HEADER = '_dedupe_key'; // hidden column we manage
// ── COLUMN ORDER ───────────────────────────────────────────────────────────
// MUST match services/jpwSpiderPush.js leadToRow() in the backend.
const COLUMNS = [
  ['business_name',     'Business Name'],
  ['category',          'Category'],
  ['phone',             'Phone'],
  ['website',           'Website'],
  ['google_maps_url',   'Google Maps URL'],
  ['address',           'Address'],
  ['city',              'City'],
  ['county',            'County'],
  ['rating',            'Rating'],
  ['review_count',      'Review Count'],
  ['lead_score',        'Lead Score'],
  ['priority_grade',    'Priority Grade'],
  ['recommended_offer', 'Recommended Offer'],
  ['main_pain_point',   'Main Pain Point'],
  ['buying_signal',     'Buying Signal'],
  ['pitch_angle',       'Pitch Angle'],
  ['opener',            'Opener'],
  ['call_status',       'Status'],
  ['last_checked',      'Last Checked'],
  ['source',            'Source'],
  ['notes',             'Notes'],
];

// ─────────────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (!body.secret || body.secret !== SHARED_SECRET) {
      return json({ ok: false, message: 'Invalid secret.' });
    }
    const targetTab = body.target_tab || 'JPW Recon';
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json({ ok: true, results: [] });

    const sheet = getOrCreateSheet(targetTab);
    const dedupeColIdx = ensureSchema(sheet);
    const existingKeys = readDedupeKeys(sheet, dedupeColIdx);

    const toAppend = [];
    const results = [];
    rows.forEach(function (r) {
      const key = String(r.dedupe_key || '');
      if (key && existingKeys.has(key)) {
        results.push({ dedupe_key: key, status: 'already_present' });
        return;
      }
      toAppend.push(buildRow(r, key, dedupeColIdx));
      if (key) existingKeys.add(key);
      results.push({ dedupe_key: key, status: 'appended' });
    });

    if (toAppend.length) {
      const startRow = sheet.getLastRow() + 1;
      sheet
        .getRange(startRow, 1, toAppend.length, toAppend[0].length)
        .setValues(toAppend);
      // Fill the dedupe column too if any keys were provided.
      let i = 0;
      results.forEach(function (res) {
        if (res.status === 'appended') {
          res.row = startRow + i;
          i++;
        }
      });
    }
    return json({ ok: true, results: results });
  } catch (err) {
    return json({ ok: false, message: String(err && err.message || err) });
  }
}

// GET — health check for manual debugging.
function doGet() {
  return json({ ok: true, message: 'JPW Spider endpoint up. POST JSON to push leads.' });
}

// ─────────────────────────────────────────────────────────────────────────────
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

// Make sure the header row exists and the dedupe column is present. Returns
// the 1-based column index of the dedupe column.
function ensureSchema(sheet) {
  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    // Brand new sheet — write headers
    const headers = COLUMNS.map(function (c) { return c[1]; });
    headers.push(DEDUPE_COLUMN_HEADER);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.hideColumns(headers.length); // hide the dedupe column
    return headers.length;
  }
  // Existing sheet — verify dedupe column, add it at the end if missing
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let idx = headers.indexOf(DEDUPE_COLUMN_HEADER) + 1;
  if (idx === 0) {
    idx = lastCol + 1;
    sheet.getRange(1, idx).setValue(DEDUPE_COLUMN_HEADER);
    sheet.hideColumns(idx);
  }
  return idx;
}

function readDedupeKeys(sheet, dedupeColIdx) {
  const lastRow = sheet.getLastRow();
  const set = new Set();
  if (lastRow < 2) return set;
  const values = sheet.getRange(2, dedupeColIdx, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const v = String(values[i][0] || '').trim();
    if (v) set.add(v);
  }
  return set;
}

function buildRow(payload, dedupeKey, dedupeColIdx) {
  // Allocate a row sized to the widest known schema (dedupe col is the
  // last column). This way an older sheet that has more columns than COLUMNS
  // — e.g. a manual extra column added by the user — won't crash, we just
  // leave those cells alone via padding nulls.
  const width = Math.max(dedupeColIdx, COLUMNS.length + 1);
  const row = new Array(width).fill('');
  COLUMNS.forEach(function (c, i) {
    const key = c[0];
    const v = payload[key];
    row[i] = (v === undefined || v === null) ? '' : v;
  });
  row[dedupeColIdx - 1] = dedupeKey;
  return row;
}
