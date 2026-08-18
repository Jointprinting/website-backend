// utils/printLocations.js
//
// ONE GARMENT, SEVERAL DECORATIONS.
//
// A confirmation item used to carry a single `printType`, so a shirt with a
// screen-printed front and a DTG back could only be described as one or the
// other. The owner's words: "if a garment has screen print and DTG that doesn't
// let me." `printLocations` is the per-place list; these helpers turn it back
// into the flat `printType` / `printDetails` strings that the PDF, the PO
// builder and the client document already read, so nothing downstream has to
// learn a new shape to keep working.
//
// MIRRORED on the client in website-frontend/src/screens/studio/_printLocations.js.

const s = (v) => String(v == null ? '' : v).trim();

// Only entries that actually say something — a blank row the owner added and
// never filled must not widen the summary or invent a method.
function realLocations(list) {
  return (Array.isArray(list) ? list : [])
    .filter((l) => l && (s(l.location) || s(l.method) || s(l.details)));
}

// The distinct METHODS on this garment, in the order they appear.
// ['Screen Print', 'DTG'] for a screen front + DTG back.
function methodsOf(list) {
  const out = [];
  for (const l of realLocations(list)) {
    const m = s(l.method);
    if (m && !out.some((x) => x.toLowerCase() === m.toLowerCase())) out.push(m);
  }
  return out;
}

// The flat `printType` for an item: every distinct method, joined. One method
// reads exactly as it always did ("Screen Print"); two read "Screen Print + DTG",
// which is the honest answer the single field could never give.
function summarizeType(list) {
  return methodsOf(list).join(' + ');
}

// The flat `printDetails`: each location described in full.
// "Front: Screen Print 3 color · Back: DTG 12x16"
function summarizeDetails(list) {
  return realLocations(list)
    .map((l) => {
      const where = s(l.location);
      const what = [s(l.method), s(l.details)].filter(Boolean).join(' ');
      if (where && what) return `${where}: ${what}`;
      return where || what;
    })
    .filter(Boolean)
    .join(' · ');
}

// Fold the locations into an item's flat fields. Returns the patch to apply —
// empty when there are no real locations, so an item that never used them keeps
// whatever the owner typed by hand.
function flatFieldsFor(list) {
  if (!realLocations(list).length) return {};
  return { printType: summarizeType(list), printDetails: summarizeDetails(list) };
}

module.exports = { realLocations, methodsOf, summarizeType, summarizeDetails, flatFieldsFor };
