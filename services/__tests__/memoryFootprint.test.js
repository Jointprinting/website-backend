// services/__tests__/memoryFootprint.test.js
//
// This API runs on a 512 MB box. Render killed it with status 134 (SIGABRT —
// the JS heap running out) repeatedly, and every time it died the outreach
// engine stopped ticking: "last run 19h ago" under a "0 of 40 sent" banner.
//
// Both fixes here are one-liners that look like nothing and are trivially
// deleted by accident, and if either goes the box starts dying again with no
// signal but a crash email. So they're pinned.
//
//   node --test services/__tests__/memoryFootprint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── The heap ceiling ─────────────────────────────────────────────────────────
// Node sizes its default heap from the HOST's memory, not the container's
// limit. In a 512 MB instance it will happily grow past 512 MB, and the
// container kills it — which is exactly what status 134 is. Telling V8 the real
// ceiling makes it collect garbage instead of dying.

test('the server starts with a heap ceiling that fits the instance', () => {
  const pkg = JSON.parse(read('package.json'));
  const start = String(pkg.scripts && pkg.scripts.start);
  const m = start.match(/--max-old-space-size=(\d+)/);
  assert.ok(m, 'start script must cap the old-space heap — without it Node sizes from host RAM and the container OOM-kills it');
  const mb = Number(m[1]);
  // Room for the rest of the process: the Node runtime itself, native buffers,
  // and every socket/TLS allocation live OUTSIDE this number.
  assert.ok(mb <= 400, `heap ceiling ${mb}MB leaves too little headroom in a 512MB instance`);
  assert.ok(mb >= 256, `heap ceiling ${mb}MB is too small to serve requests`);
});

// ── The IMAP metadata pass ───────────────────────────────────────────────────

test('the folder scan does not hold a MIME tree per message', () => {
  const src = read('services/replyImap.js');
  const meta = src.match(/\{ uid: true, envelope: true[^}]*\}/);
  assert.ok(meta, 'metadata fetch options not found');
  // bodyStructure is a parsed MIME tree PER MESSAGE, and this pass covers up to
  // MAX_PER_FOLDER messages across nine folders — for data only the rare
  // oversized-message path reads. It is fetched lazily instead.
  assert.doesNotMatch(meta[0], /bodyStructure/,
    'the bulk metadata pass must not request bodyStructure');
  // ...but the fallback still has to be able to get one.
  assert.match(src, /fetchOne\(meta\.uid, \{ bodyStructure: true \}/);
});

// ── Cron collisions ──────────────────────────────────────────────────────────
// Everything scheduled with */N fires on minute 0. That put the IMAP sync, the
// send tick, the enroll fill AND the six-hourly lead-finder sweep — the
// heaviest job in the process — on the same minute, four times a day.

test('the recurring jobs do not all fire on the same minute', () => {
  const files = [
    'controllers/replyTriage.js',
    'controllers/outreach.js',
    'services/outreachEngine.js',
    'services/leadFinderScheduler.js',
  ];
  const minuteZero = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/cron\.schedule\(\s*'([^']+)'/g)) {
      const minute = m[1].split(/\s+/)[0];
      // '*/N' and '0' both fire on the hour; a comma list of offsets does not.
      if (minute === '0' || /^\*\/\d+$/.test(minute)) minuteZero.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(minuteZero, [],
    `these all fire on minute 0 together on a 512MB box:\n  ${minuteZero.join('\n  ')}`);
});
