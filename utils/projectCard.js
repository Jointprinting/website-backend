'use strict';

const Order = require('../models/Order');

// ── The project CARD ─────────────────────────────────────────────────────────
//
// GET /api/orders/projects feeds three surfaces: the Order Tracker board, the
// Mockup Lab's project typeahead, and the Quoter's "copy an earlier quote"
// picker. Not one of them renders a confirmation item, a quote line or an
// activity entry — those are read only once a project is OPENED, and every
// path that opens one for editing fetches the whole record from
// GET /api/orders/:id.
//
// Shipping them anyway was the OOM cliff. `confirmation` carries
// items[].mockupSnapshots[].dataUrl, which is base64 whenever the R2 upload
// fell back, and `quoteLines` carries a per-line `image` that is a data URL for
// any promo item with no mockup number. The endpoint had no .select() and no
// limit, so one board load allocated every order's artwork on a 352MB heap.
//
// So the feed returns a CARD. This is a REMOVAL, never a rename: every other
// field passes through verbatim, so a field added to the schema tomorrow
// reaches the board with no change here. The four heavy subtrees are replaced
// by the handful of summaries the board actually reads off them.
const HEAVY_FIELDS = ['confirmation', 'quoteLines', 'quoteLinesPublished', 'activity'];

function projectCard(order) {
  if (!order || typeof order !== 'object') return order;

  const card = { ...order };
  for (const f of HEAVY_FIELDS) delete card[f];

  const conf = order.confirmation;
  const confItems = (conf && Array.isArray(conf.items)) ? conf.items : [];
  card.hasConfirmationItems = confItems.length > 0;

  // The card shows the client-approved confirmation's revenue when one exists,
  // and it has to agree with the drawer to the cent — so it comes from the SAME
  // computeConfirmationTotals the model stores `totalValue` from, never a second
  // implementation of the grand total. (There were five of those; see the tax
  // work in confTax.js for why that matters.)
  card.confirmationRevenue = confItems.length
    ? Order.computeConfirmationTotals(conf).grandTotal
    : 0;
  card.confirmationPublishedAt = (conf && conf.publishedAt) || null;

  const lines = Array.isArray(order.quoteLines) ? order.quoteLines : [];
  card.quoteLineCount = lines.length;
  // Distinct non-empty `group` labels = how many option sets the client picks
  // between. The copy-an-earlier-quote picker shows this to tell a one-line
  // quote from a three-option pitch without downloading either.
  card.quoteGroupCount = new Set(
    lines.map((l) => String((l && l.group) || '').trim()).filter(Boolean),
  ).size;
  card.quoteAcceptedCount = lines.filter((l) => l && l.accepted).length;

  return card;
}

module.exports = { projectCard, HEAVY_FIELDS };
