// controllers/__tests__/submissions.test.js
//
// Pure-logic checks for the submissions controller (no DB):
//
//   node --test controllers/__tests__/submissions.test.js
//
// getUnseenCount's optional ?source= scope mirrors markAllSeen's: the Studio
// hub badges contact-form leads and JP Webworks inquiries separately, so each
// tile fetches its own count. The model's countDocuments is stubbed so the
// test asserts on the exact filter the handler builds.

const test = require('node:test');
const assert = require('node:assert/strict');

const ContactSubmission = require('../../models/ContactSubmission');
const { getUnseenCount } = require('../submissions');

function mockRes() {
  return {
    _status: 200, _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}

// Run the handler with countDocuments stubbed; returns { filter, res }.
async function callUnseen(query) {
  const orig = ContactSubmission.countDocuments;
  let captured = null;
  ContactSubmission.countDocuments = async (filter) => { captured = filter; return 7; };
  try {
    const res = mockRes();
    await getUnseenCount({ query }, res);
    return { filter: captured, res };
  } finally {
    ContactSubmission.countDocuments = orig;
  }
}

test('getUnseenCount: no source → the original combined count (no source in the filter)', async () => {
  const { filter, res } = await callUnseen({});
  assert.equal(res._json.count, 7);
  assert.equal('source' in filter, false);
  // The base gates are untouched: new + unseen + not a honeypot bot.
  assert.equal(filter.status, 'new');
  assert.deepEqual(filter.seenByAdmin, { $ne: true });
  assert.deepEqual(filter.honeypot, { $ne: true });
});

test('getUnseenCount: valid sources scope the count (mirrors markAllSeen)', async () => {
  assert.equal((await callUnseen({ source: 'webworks' })).filter.source, 'webworks');
  assert.equal((await callUnseen({ source: 'contact' })).filter.source, 'contact');
});

test('getUnseenCount: an unknown source is ignored, not trusted into the query', async () => {
  const { filter } = await callUnseen({ source: 'bogus' });
  assert.equal('source' in filter, false);
});
