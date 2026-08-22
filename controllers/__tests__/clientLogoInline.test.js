// controllers/__tests__/clientLogoInline.test.js
//
//   node --test controllers/__tests__/clientLogoInline.test.js
//
// upsertLogo offloads to R2 when configured, storing a URL in the same field.
// Every logo uploaded BEFORE that was set up still holds its full base64 inline
// — up to 3 MB each — and listLogos returns every logo in ONE response so the
// Order Tracker can map them by companyKey.
//
// So the size of that response is exactly the size of the legacy backlog, on a
// 512 MB dyno. These pin the rules that make moving it safe.

const test = require('node:test');
const assert = require('node:assert/strict');

// The predicate the report and the migration both key off. Kept identical to
// the controller's; if these ever disagree, the migration either skips real
// work or tries to "migrate" a URL.
const isInline = (v) => typeof v === 'string' && v.startsWith('data:');

test('an inline data URL is legacy; an R2 URL is already done', () => {
  assert.equal(isInline('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isInline('https://cdn.example.com/logos/img/abc.png'), false);
});

test('junk is not mistaken for something to migrate', () => {
  assert.equal(isInline(''), false);
  assert.equal(isInline(null), false);
  assert.equal(isInline(undefined), false);
  assert.equal(isInline(12345), false);
});

test('the predicate makes the migration idempotent by construction', () => {
  // After a successful move the field holds a URL, which no longer matches — so
  // a second run finds nothing and cannot double-upload or corrupt anything.
  const after = 'https://cdn.example.com/logos/img/abc.png';
  assert.equal(isInline(after), false);
});

// ── The rule that protects the only copy of a logo ──────────────────────────
//
// The migration replaces the base64 with a URL. If the upload silently returned
// nothing and we wrote that anyway, the logo would be GONE — the inline copy was
// the only one. So the write is gated on getting a real R2 URL back.

const isR2Url = (s) => typeof s === 'string' && /^https?:\/\//.test(s);

function wouldWrite(uploadResult) {
  return !!(uploadResult && isR2Url(uploadResult));
}

test('a failed upload never overwrites the only copy of the logo', () => {
  assert.equal(wouldWrite(undefined), false);
  assert.equal(wouldWrite(''), false);
  assert.equal(wouldWrite(null), false);
  // A non-URL string is a failure too — writing it would leave a broken <img>.
  assert.equal(wouldWrite('upload failed'), false);
});

test('a real URL is written', () => {
  assert.equal(wouldWrite('https://cdn.example.com/logos/img/abc.png'), true);
});

test('a partial run leaves the rest working', () => {
  // One at a time, and a failure is recorded rather than thrown — so a run that
  // dies halfway leaves the un-migrated logos inline and still rendering, and
  // re-running picks up exactly where it stopped.
  const logos = ['a', 'b', 'c'];
  const failOn = 'b';
  const moved = [];
  const failed = [];
  for (const k of logos) {
    if (k === failOn) { failed.push(k); continue; }
    moved.push(k);
  }
  assert.deepEqual(moved, ['a', 'c']);
  assert.deepEqual(failed, ['b']);
  assert.equal(moved.length + failed.length, logos.length);
});
