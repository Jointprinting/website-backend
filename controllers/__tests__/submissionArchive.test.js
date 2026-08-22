// controllers/__tests__/submissionArchive.test.js
//
//   node --test controllers/__tests__/submissionArchive.test.js
//
// ContactSubmission was the last collection in the system that HARD-deleted, and
// of all of them it was the worst candidate: a submission is an inbound LEAD —
// the record that someone asked. Orders, POs, vendors, clients, deals,
// transactions, logos and mockups all archive.
//
// It also carries data captured nowhere else: the in-hands date the lead typed,
// the quantity they wanted, which brand they came through. Deleting the row lost
// the only structured record of the original ask.

const test = require('node:test');
const assert = require('node:assert/strict');

const ContactSubmission = require('../../models/ContactSubmission');
const { scopeLiveFilter } = require('../../utils/archiveScope');

test('a new submission is live', () => {
  const s = new ContactSubmission({ name: 'Someone' });
  assert.equal(s.archived, false);
  assert.equal(s.archivedAt, null);
});

test('the model carries the archive fields at all', () => {
  // The whole point — before this, there was nowhere to record the archive, so
  // the only way to make a lead disappear was to destroy it.
  const paths = ContactSubmission.schema.paths;
  assert.ok(paths.archived, 'archived');
  assert.ok(paths.archivedAt, 'archivedAt');
  assert.ok(paths.archivedReason, 'archivedReason');
});

test('every ordinary read excludes archived automatically', () => {
  // There are read sites in submissions, signals and the order bridge.
  // Hand-filtering each is how one missed site resurrects a deleted lead in a
  // hub badge, which is why this is a schema-level guard rather than a
  // convention.
  assert.deepEqual(scopeLiveFilter({ status: 'new' }), { status: 'new', archived: { $ne: true } });
});

test('the restore path can still SEE the archived row', () => {
  // The guard deliberately steps aside once a filter mentions `archived`
  // itself — otherwise restore could never match the thing it is restoring.
  assert.deepEqual(
    scopeLiveFilter({ _id: 'x', archived: true }),
    { _id: 'x', archived: true },
  );
});

test('an unseen-count query is scoped too, so an archived lead stops badging', () => {
  assert.deepEqual(
    scopeLiveFilter({ seenByAdmin: false }),
    { seenByAdmin: false, archived: { $ne: true } },
  );
});
