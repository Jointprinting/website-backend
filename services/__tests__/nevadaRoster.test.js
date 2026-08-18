// services/__tests__/nevadaRoster.test.js
//
// Las Vegas showed ~36 pins against ~72 licensed storefronts in the valley.
// Two of the reasons a state can arrive half-loaded, both pinned here.
//
//   node --test services/__tests__/nevadaRoster.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { rowPasses } = require('../dispensaryIngest');
const { ROSTER_STATES } = require('../dispensaryStates');

const MAP = { licenseType: 'license_type', licenseStatus: 'license_status', name: 'dba' };
const mk = (type, status = 'Active') => ({ license_type: type, license_status: status, dba: 'X' });

// ── A medical certificate can name a real storefront ─────────────────────────

test('Nevada is declared a dual-licence market', () => {
  // Which licensing regime a state runs is a fact about the state, so it lives
  // on the state's config rather than being inferred inside the row gate.
  assert.equal(ROSTER_STATES.NV.dualLicence, true);
});

test('Nevada medical dispensary certificates are kept', () => {
  // The CCB issues "Medical Marijuana Dispensary" to ordinary walk-in stores on
  // the Strip, most of which hold an adult-use certificate too. The anchored
  // MEDICAL_ONLY_TYPE pattern matched that string exactly, so every one of them
  // was discarded before it could become a pin.
  const nv = { dualLicence: true };
  assert.equal(rowPasses(mk('Medical Marijuana Dispensary'), MAP, null, nv), true);
  assert.equal(rowPasses(mk('Medical Cannabis Dispensary'), MAP, null, nv), true);
  assert.equal(rowPasses(mk('Adult-Use Retail Store'), MAP, null, nv), true);
});

test('a storefront word is still required, even in a dual-licence state', () => {
  const nv = { dualLicence: true };
  // A bare medical-program entity names no storefront and stays out.
  assert.equal(rowPasses(mk('Medical'), MAP, null, nv), false);
  assert.equal(rowPasses(mk('Med'), MAP, null, nv), false);
  // ...and non-retail activity is still non-retail.
  assert.equal(rowPasses(mk('Medical Cultivation Facility'), MAP, null, nv), false);
  assert.equal(rowPasses(mk('Cannabis Laboratory'), MAP, null, nv), false);
  // Dead licences never pass, whatever the type says.
  assert.equal(rowPasses(mk('Medical Marijuana Dispensary', 'Revoked'), MAP, null, nv), false);
});

test('a single-regime rec state is unchanged', () => {
  // New York's medical side is a separate registered-organization regime, not a
  // storefront licence — the original rule is right there and must not move.
  assert.equal(rowPasses(mk('Medical Dispensary'), MAP, null, {}), false);
  assert.equal(rowPasses(mk('Adult-Use Retail Dispensary'), MAP, null, {}), true);
});

// ── A broken state must not starve the ones behind it ────────────────────────

test('a roster that imports nothing gets stamped for cooldown', () => {
  const src = require('fs').readFileSync(require.resolve('../rosterAutopilot'), 'utf8');
  const branch = src.match(/if \(importedNothing\) \{[\s\S]*?\n    \}/);
  assert.ok(branch, 'importedNothing branch not found');
  // The comment above it always promised the state would "cool down"; the code
  // never set the stamp. Each tick runs only MAX_PER_TICK states, so a state
  // that re-fails every tick permanently consumes a slot and starves every
  // state behind it in the priority order out of ever loading at all.
  assert.match(branch[0], /_failedAt\.set\(st, Date\.now\(\)\)/,
    'a zero-importing state must cool down, or it eats a tick slot forever');
});
