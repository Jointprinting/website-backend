// controllers/__tests__/webworksLead.test.js
//
// The JP Webworks lead intake shares the ContactSubmission collection with the
// merch contact form but has its OWN validation: name + business name + email
// are required, phone is optional (web leads often start with just an email),
// and none of the print-specific fields (quantity / in-hand / ship-to) apply.
// These pin that contract + the notes-flattening used so the whole lead shows
// in the Studio inbox. Pure functions — no DB, no SMTP:
//
//   node --test controllers/__tests__/webworksLead.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateWebworksPayload, composeWebworksNotes } = require('../email');

test('accepts a minimal lead (name + business + email, no phone)', () => {
  const { errors, cleaned } = validateWebworksPayload({
    name: '  Sam Rivera ', companyName: 'Rivera Roofing', email: 'SAM@Rivera.com ',
  });
  assert.deepEqual(errors, []);
  assert.equal(cleaned.name, 'Sam Rivera');
  assert.equal(cleaned.companyName, 'Rivera Roofing');
  assert.equal(cleaned.phone, ''); // optional — absent is fine
});

test('accepts businessName as an alias for companyName', () => {
  const { errors, cleaned } = validateWebworksPayload({
    name: 'Sam', businessName: 'Rivera Roofing', email: 'sam@rivera.com',
  });
  assert.deepEqual(errors, []);
  assert.equal(cleaned.companyName, 'Rivera Roofing');
});

test('requires name, business name, and email', () => {
  const { errors } = validateWebworksPayload({});
  assert.ok(errors.includes('name is required'));
  assert.ok(errors.includes('business name is required'));
  assert.ok(errors.includes('email is required'));
});

test('rejects an invalid email and a garbage phone', () => {
  const { errors } = validateWebworksPayload({
    name: 'Sam', companyName: 'Rivera Roofing', email: 'not-an-email', phone: 'abc',
  });
  assert.ok(errors.includes('email is invalid'));
  assert.ok(errors.includes('phone format is invalid'));
});

test('a present, well-formed phone passes', () => {
  const { errors } = validateWebworksPayload({
    name: 'Sam', companyName: 'Rivera Roofing', email: 'sam@rivera.com', phone: '(555) 123-4567',
  });
  assert.deepEqual(errors, []);
});

test('composeWebworksNotes flattens the structured fields + free text', () => {
  const notes = composeWebworksNotes({
    businessType: 'Roofing', serviceArea: 'Your area', planInterest: 'Silver',
    currentWebsite: 'oldsite.com', notes: 'Need it before spring.',
  });
  assert.match(notes, /Business: Roofing/);
  assert.match(notes, /Service area: Your area/);
  assert.match(notes, /Plan interest: Silver/);
  assert.match(notes, /Current site: oldsite\.com/);
  assert.match(notes, /Need it before spring\./);
});

test('composeWebworksNotes omits empty fields cleanly', () => {
  const notes = composeWebworksNotes({
    businessType: '', serviceArea: '', planInterest: 'Not sure yet', currentWebsite: '', notes: '',
  });
  assert.equal(notes, 'Plan interest: Not sure yet');
});
