'use strict';

// ── What the client's per-unit price actually covers ─────────────────────────
//
// The approval page said "every price is all-in per unit" and left it there.
// The owner's read on his own page: "the copy probably needs work cause I don't
// think it says it includes shipping."
//
// It usually does. lineCogsPerUnit spreads a line's setup and shipping across
// its own quantity, so both are already inside the number the client sees. But
// "usually" is the problem — whether they are depends on how that quote was
// built, and a confirmation can still add a shipping reserve as a custom line.
// So this is DERIVED from the quote rather than written into the copy: the page
// only makes a promise the lines actually back.
//
// Costs themselves never leave the server (supplier pricing must not ride out to
// a public route — see the pushed snapshot). These are booleans about the
// client's own price, which is a fact they are entitled to.
//
// ALL-or-nothing on purpose. If one option has freight priced in and another
// doesn't, "shipping included" is false for the option they might pick, and a
// wrong promise on a page someone signs is worse than a quiet one.

const n = (v) => (Number(v) || 0);

function priceIncludesFor(lines) {
  // The offer as the client sees it: parked lines aren't on their page.
  const offered = (Array.isArray(lines) ? lines : [])
    .filter((l) => l && !l.hiddenFromClient);

  if (!offered.length) return { setup: false, shipping: false, turnaroundWeeks: 0 };

  return {
    setup: offered.every((l) => n(l.setupCost) > 0),
    shipping: offered.every((l) => n(l.shippingCost) > 0),
    // The longest lead time on offer — quoting the shortest would be a promise
    // the slowest option can't keep. 0 means the owner didn't set one, and the
    // page says nothing rather than inventing a number.
    turnaroundWeeks: offered.reduce((m, l) => Math.max(m, n(l.turnaroundWeeks)), 0),
  };
}

module.exports = { priceIncludesFor };
