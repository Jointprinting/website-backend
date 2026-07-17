// utils/brands.js
//
// The one canonical brand vocabulary for the Joint Printing ecosystem. The
// business runs THREE brands, and a lead/order already carries its brand as its
// inquiry source — see services/signals.js `INQUIRY_BRANDS` and
// `Order.inquirySource` / `ContactSubmission.source` (values: contact, webworks,
// atom). This module is the single place those source keys map to display labels
// and accent colors, so the money layer (brand-tagged ledger, brand P&L,
// subscription MRR) can group by brand without re-deriving the mapping.
//
// Keys are the SAME strings the rest of the ecosystem already uses
// (`contact` = Joint Printing), so a transaction's brand can be read straight off
// its order's `inquirySource` with no translation layer.
//
// Mirrored on the frontend by src/common/BrandCube.js (BRAND_ACCENT, keyed by the
// display label) and src/screens/studio/_submissions.js (SOURCE_META). Keep the
// accent hexes in sync — a drift test guards the values.

const BRANDS = [
  { key: 'contact',  label: 'Joint Printing', accent: '#4ade80' }, // the print shop (contact-form leads)
  { key: 'webworks', label: 'JP Webworks',    accent: '#54a6ff' }, // websites on subscription
  { key: 'atom',     label: 'JP Atom',        accent: '#9e82ff' }, // AI-built business systems
];

const BRAND_KEYS = BRANDS.map((b) => b.key);

// Brands that sell on a RECURRING subscription. Joint Printing bills per order, so
// it's excluded from the subscription spine; the two service brands recur.
const SUBSCRIPTION_BRAND_KEYS = ['webworks', 'atom'];

const _byKey = new Map(BRANDS.map((b) => [b.key, b]));

function isBrand(key) {
  return _byKey.has(String(key || ''));
}

function brandLabel(key) {
  const b = _byKey.get(String(key || ''));
  return b ? b.label : '';
}

function brandAccent(key) {
  const b = _byKey.get(String(key || ''));
  return b ? b.accent : '';
}

module.exports = {
  BRANDS,
  BRAND_KEYS,
  SUBSCRIPTION_BRAND_KEYS,
  isBrand,
  brandLabel,
  brandAccent,
};
