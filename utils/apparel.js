// utils/apparel.js
//
// APPAREL vs PROMO — the distinction that decides who supplies the blanks.
//
// The owner's rule, in his words: printers supply the blanks ONLY for promo
// products (lighters, stress balls) because they manufacture and print those
// themselves. Apparel he buys from S&S or an approved vendor and ships to the
// printer, so on an apparel job HE supplies the blanks.
//
// So `blanksProvided` is not really a property of the VENDOR — it's a property
// of what's being made. The vendor only correlates with it (a promo house makes
// promo). The PO seeders used to read the vendor's remembered boolean and
// nothing else, which got the common case right by luck and the mixed case
// wrong on principle.
//
// The system already knows apparel from promo, for a different reason: NJ
// exempts CLOTHING from sales tax, so every confirmation item carries
// `taxExempt`. That flag is the same question with a different hat on, and the
// owner already curates it per item — so the blanks rule reads it rather than
// inventing a second flag that could disagree with the first.
//
// APPAREL_RE is a MIRROR of the frontend's (src/screens/studio/ConfirmationBuilder.js,
// `isApparelDescription`) — the two must stay in sync; it's the same guess that
// seeds taxExempt in the builder.

const APPAREL_RE = /\b(tee|t-?shirts?|shirts?|hoodies?|hoods?|crewnecks?|crews?|sweatshirts?|sweaters?|sweatpants?|joggers?|pants?|shorts?|polos?|long ?sleeves?|tanks?|jackets?|windbreakers?|beanies?|hats?|caps?|socks?|apparel|jerse?ys?|zip[- ]?ups?|pullovers?|fleece)\b/i;

function isApparelDescription(s) {
  return APPAREL_RE.test(String(s || ''));
}

// Is this confirmation item apparel?
//
// taxExempt === true is the OWNER-CONFIRMED answer (he flagged it clothing-exempt),
// so it's trusted outright. taxExempt === false is NOT trusted as "promo", because
// the field DEFAULTS to false — an apparel item that simply never got flagged
// would otherwise read as promo and quietly claim the printer supplied the
// garments. So a false falls through to the wording guess.
//
// The asymmetry is deliberate and errs toward apparel, which is both the ~99%
// case and the safer mistake: over-calling apparel produces a blanks-receipt nag
// you can dismiss, while under-calling it produces a missing cost record you
// never hear about.
function isApparelItem(it) {
  if (!it) return false;
  if (it.taxExempt === true) return true;
  return isApparelDescription(`${it.description || ''} ${it.styleCode || ''}`);
}

// Who supplies the blanks for this set of items?
//   apparel → JP buys them and ships to the printer            → true
//   promo   → the printer manufactures and prints them         → false
//
// A MIXED group is TRUE: it contains apparel blanks that JP bought, so the
// Blank COGS receipt for them genuinely exists and should be expected.
//
// Returns null when there is nothing to judge, so the caller can fall back to
// the vendor's remembered mode rather than asserting either way.
function blanksModeForItems(items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return list.some(isApparelItem);
}

module.exports = { APPAREL_RE, isApparelDescription, isApparelItem, blanksModeForItems };
