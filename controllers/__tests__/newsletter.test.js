// controllers/__tests__/newsletter.test.js
//   node --test controllers/__tests__/newsletter.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { bodyToHtml } = require('../newsletter');

test('bodyToHtml wraps blank-line paragraphs and escapes HTML', () => {
  const html = bodyToHtml("Hi there!\n\nOur <winter> catalog is out.\nCheck it out.");
  assert.match(html, /<p[^>]*>Hi there!<\/p>/);
  assert.match(html, /Our &lt;winter&gt; catalog is out\.<br>Check it out\./);
  assert.equal((html.match(/<p/g) || []).length, 2);
});

test('bodyToHtml on empty input is empty (no stray tags)', () => {
  assert.equal(bodyToHtml(''), '');
  assert.equal(bodyToHtml(null), '');
});
