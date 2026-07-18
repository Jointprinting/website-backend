// utils/companyKey.js
//
// The ONE canonical companyKey derivation, shared so every collection keys a
// company the same way. Mirrors models/Order.js deriveCompanyKey byte-for-byte
// (companyName first, clientName fallback, lowercased, everything but [a-z0-9]
// squeezed out) and the frontend _shared.deriveCompanyKey — so an Order, a
// Lookbook, a ClientLogo, and now a StudioLibraryItem mockup all land on the
// exact same key and join cleanly.

function deriveCompanyKey(companyName, clientName) {
  const raw = (companyName || clientName || '').toString();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Normalize a mockup number for matching (e.g. "#000150A" → "150A"): drop the
// hash + separators, uppercase, strip leading zeros but KEEP the colour letter
// / version digit that distinguish sibling mockups. Used to map a mockup back to
// the order that references its number. Mirrors the CRM's normMockupNum intent.
function normMockupNum(n) {
  return String(n == null ? '' : n).replace(/[^0-9a-z]/gi, '').toUpperCase().replace(/^0+/, '');
}

module.exports = { deriveCompanyKey, normMockupNum };
