const mongoose = require('mongoose');
const crypto = require('crypto');

function deriveCompanyKey(companyName, clientName) {
  const raw = (companyName || clientName || '').toString();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Quote totals from the lines. Setup + shipping are per-line — each option
// carries its FULL setup/shipping, spread across its own quantity into the unit
// cost (so 3 alternative options each bear the full cost, never shared). Legacy
// order-level setup/shipping are only folded in when no line carries its own,
// so pre-existing quotes keep their totals until they're re-saved.
//
// A quote is a PROPOSAL, not a sale — so it is worth $0 to the pipeline until
// the client actually commits by picking their options. Before that we return
// zero rather than summing the lines: a pitch of 10 alternative options would
// otherwise read as a 10-option ORDER and inflate the owner's project totals
// for a quote the client may not have even opened. Once the client picks, the
// real order is their accepted picks PLUS any always-included standalone
// (ungrouped) lines; a group the client DECLINED contributes nothing (the
// "pitch 10, take the 5 you want" case). A built confirmation supersedes this
// entirely in the save hooks — the client's approved confirmation is the money.
function computeQuoteTotals(lines, orderSetup, orderShip) {
  // Hidden lines are owner-only parking — never part of what the client can
  // take, so never part of the money.
  const all = (Array.isArray(lines) ? lines : []).filter(l => l && !l.hiddenFromClient);
  if (!all.some(l => l && l.accepted)) return { totalValue: 0, cogs: 0 };
  // Post-pick: accepted picks + always-included standalone lines only. Grouped
  // alternatives the client didn't accept (a declined category, or the two
  // brands they passed on) drop out — summing them would re-inflate the total.
  const arr = all.filter(l => l && (l.accepted || !l.group));
  const n = (v) => Number(v) || 0;
  const perLineExtras = arr.reduce((s, l) => s + n(l.setupCost) + n(l.shippingCost), 0);
  const legacy = perLineExtras === 0 ? (n(orderSetup) + n(orderShip)) : 0;
  const totalValue = arr.reduce((s, l) => {
    const qty = n(l.qty);
    const setupShip = n(l.setupCost) + n(l.shippingCost);
    const unitCogs = n(l.blankCost) + n(l.printCost) + (qty > 0 ? setupShip / qty : 0);
    // Unit price = the owner's committed price, else cost × markup. Markup
    // falls back to the 1.4 schema default (NEVER ×1 = sell-at-cost) so a line
    // that never got a tier click still carries a real margin, not $0 profit.
    const unit = n(l.unitPrice) || unitCogs * (n(l.markup) || 1.4);
    return s + qty * unit;
  }, 0) + legacy;
  const cogs = arr.reduce((s, l) =>
    s + n(l.qty) * (n(l.blankCost) + n(l.printCost)) + n(l.setupCost) + n(l.shippingCost), 0) + legacy;
  return { totalValue, cogs };
}

// Auto-prefill sales-tax rate (percent) for the owner's ONLY nexus: New Jersey.
// Joint Printing is NJ-based and registered nowhere else, so it collects NJ tax
// on NJ-bound taxable goods and NOTHING on out-of-state shipments (which it keeps
// nexus-free by routing print/ship through a printer outside the client's state).
// Choosing a state on a confirmation shipTo PRE-FILLS its taxRate ONLY for NJ;
// any other state prefills nothing (stays 0 = untaxed). The per-location "Tax
// rate %" field is a manual override, so a new nexus can still be typed in by
// hand if the owner ever registers elsewhere. Keyed by USPS code.
const STATE_TAX_RATES = { NJ: 6.625 };

// Round-half-up to cents. Confirmation grand totals and tax lines are summed in
// floating point and MUST be snapped to cents at their final points, or they
// drift by fractions of a cent (a $2,203.3000000001 grand total). Number.EPSILON
// nudges values that are mathematically *.xx5 but land just under in binary
// (e.g. 1.005) up to the correct cent. Mirrored in every frontend copy.
const roundCents = (v) => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

// Is this add-on customLine a SALES-TAX line? A confirmation can carry a legacy
// flat/percent "NJ tax" customLine (the builder's one-tap preset) AND, on the
// newer multi-ship-to path, per-location taxRates. Applying both double-taxes the
// job. We detect a tax line by an explicit `isTax` flag (honored if present) or,
// for back-comp with already-saved confirmations that predate the flag, a label
// that mentions "tax". Kept deliberately broad on the label so a saved
// "NJ sales tax" / "Sales Tax" / "NY tax" line is all caught. Mirrored on the
// frontend so the builder preview, PDF, approval page and the order's stored
// total all agree.
function isTaxCustomLine(line) {
  if (!line) return false;
  if (line.isTax === true) return true;
  return /tax/i.test(String(line.label || ''));
}

// A baked payment-processing-fee customLine — a "Card fee" or "ACH fee" the owner
// added himself. Its PRESENCE is the single source of truth for the fee model: if
// the owner baked a payment fee, the client approval page HIDES its payment-method
// picker (otherwise the client's pick would apply a second fee). If he baked none,
// the client picks how to pay and the fee is applied there. A discount / shipping /
// tax line is NOT a payment fee, so those never suppress the picker. Never a tax line.
function isPaymentFeeCustomLine(line) {
  if (!line || isTaxCustomLine(line)) return false;
  const label = String(line.label || '');
  return /card/i.test(label) || /\bach\b|bank transfer/i.test(label);
}
// Did the owner bake a payment fee into this confirmation? Drives whether the client
// sees the payment-method picker (they pick ⟺ no baked fee). Mirrored on the frontend.
function hasBakedPaymentFee(conf) {
  return ((conf && conf.customLines) || []).some(isPaymentFeeCustomLine);
}

// Per-location sales tax for a confirmation that ships to multiple destinations
// with their own tax rates. ACTIVE only when at least one shipTo carries a
// taxRate > 0 — otherwise this is a no-op and the grand total is byte-identical
// to a confirmation with no shipTos at all.
//
// Each item's merchandise revenue (Σ qty×unitPrice over its sizes) is allocated
// to a location PROPORTIONALLY by that location's share of the item's units:
//   locationItemRevenue = itemRevenue × (allocation.qty / itemTotalQty)
// This assumes the price mix is uniform across an item's units (the unit price
// is per size, not per destination), so revenue follows quantity. The sum over
// items is a location's taxable merchandise subtotal; × its taxRate% is that
// location's tax. Tax is on MERCHANDISE only (item revenue) — it does not stack
// on top of add-on customLines (CC fees, discounts), which is the correct sales
// tax base and avoids taxing a credit-card fee. When this is active, any legacy
// tax customLine is dropped by computeConfirmationTotals (see isTaxCustomLine),
// so a job is never taxed twice even on a saved confirmation that carries both.
// Mirrors the frontend _shared.js confLocationTax exactly.
function computeLocationTax(conf) {
  const n = (v) => Number(v) || 0;
  const shipTos = (conf && Array.isArray(conf.shipTos)) ? conf.shipTos : [];
  const taxed = shipTos.filter(st => st && n(st.taxRate) > 0);
  if (taxed.length === 0) return { active: false, total: 0, lines: [] };
  const items = (conf && Array.isArray(conf.items)) ? conf.items : [];
  const lines = taxed.map(st => {
    const subtotal = items.reduce((sum, it) => {
      // NJ clothing exemption: an item flagged taxExempt contributes nothing to
      // the taxable base — a mixed apparel+promo order taxes only the promos.
      if (it && it.taxExempt) return sum;
      const itemRevenue = ((it && it.sizes) || []).reduce((ss, sz) => ss + n(sz.qty) * n(sz.unitPrice), 0);
      const itemQty = ((it && it.sizes) || []).reduce((q, sz) => q + n(sz.qty), 0);
      if (itemQty <= 0) return sum;
      const allocQty = ((it && it.allocations) || []).reduce((q, a) => q + (a && a.key === st.key ? n(a.qty) : 0), 0);
      // Guard a bad allocation: a location's share of an item can't be negative
      // nor exceed the item's full quantity. Without this, an over-allocation
      // (allocations summing past itemQty) would tax MORE than the item's actual
      // revenue, and across locations the taxed base could exceed 100% of the
      // merchandise. Clamp so the taxed base stays within real item revenue.
      const share = allocQty <= 0 ? 0 : (allocQty >= itemQty ? 1 : allocQty / itemQty);
      return sum + itemRevenue * share;
    }, 0);
    const rate = n(st.taxRate);
    // Round each location's tax to cents — the line shown to the client and the
    // value summed into the grand total must be a real cent amount.
    const value = roundCents(subtotal * rate / 100);
    const label = `${st.label || st.name || 'Location'} tax - ${rate}%`;
    // Carry the shipTo key so consumers (the PDF) can match a location to its tax
    // line by key rather than by a fragile label prefix (which fails for a blank
    // label and collides on shared prefixes). The client web doc keys by st.key too.
    return { key: st.key, label, subtotal, rate, value };
  });
  // Sum the already-rounded line values (so total == Σ of the lines the client
  // sees), then re-round defensively.
  const total = roundCents(lines.reduce((s, l) => s + l.value, 0));
  return { active: true, total, lines };
}

// Confirmation grand total — items subtotal plus custom lines, where percent
// lines apply to the running subtotal in order. When the confirmation ships to
// multiple locations with their own tax rates, per-location tax is added LAST
// (the same place the single "NJ tax" customLine would land), so totalValue /
// finance pick it up identically. With no taxed shipTos this is byte-identical
// to before. Mirrors the builder preview, the server PDF (confirmationPdf.js)
// and the approval page exactly.
function computeConfirmationTotals(conf) {
  const n = (v) => Number(v) || 0;
  const items = (conf && Array.isArray(conf.items)) ? conf.items : [];
  const itemsSubtotal = items.reduce((s, it) =>
    s + ((it && it.sizes) || []).reduce((ss, sz) => ss + n(sz.qty) * n(sz.unitPrice), 0), 0);
  const totalUnits = items.reduce((s, it) => s + itemTotalQty(it), 0);
  const locationTax = computeLocationTax(conf);
  let running = itemsSubtotal;
  ((conf && conf.customLines) || []).forEach(l => {
    // DOUBLE-TAX GUARD: when per-location tax is active, a legacy tax customLine
    // (the "NJ tax" preset) must NOT also apply — per-location tax wins, so the
    // job is taxed exactly once. With no per-location tax a legacy tax line still
    // applies (back-comp). The builder also suppresses the conflict going forward;
    // this keeps already-saved confirmations that carry both from double-taxing.
    if (locationTax.active && isTaxCustomLine(l)) return;
    // A baked payment fee (Card/ACH) always applies here — the double-charge is
    // prevented by HIDING the client payment picker whenever such a line exists
    // (hasBakedPaymentFee), not by dropping the line. So the fee is charged once:
    // via the baked line, OR via the client's pick when there's no baked line.
    running += l && l.isPercent ? running * n(l.amount) / 100 : n(l && l.amount);
  });
  running += locationTax.total;
  // Snap the grand total to cents (the order's stored totalValue, the client's
  // headline total, and the finance number all read this) so it can't drift by a
  // fraction of a cent off the summed lines.
  return { itemsSubtotal, totalUnits, grandTotal: roundCents(running) };
}

// Estimated COGS from the CONFIRMATION's items — Σ (item qty × unitCost), the
// internal cost/unit each item carried over from its accepted quote line. Once
// a confirmation exists it IS the real order (only the client's picks get
// seeded into it, and the owner may trim/add items after), so its cost side
// supersedes the quote-stage estimate the same way its grand total supersedes
// totalValue — otherwise an order pitched with many alternatives keeps summing
// the whole pitch into COGS forever. Returns 0 when no item carries a unitCost
// (confirmations built before the field existed): callers must keep the
// quote-derived figure then, never let a legacy doc zero out a real estimate.
function computeConfirmationCogs(conf) {
  const items = (conf && Array.isArray(conf.items)) ? conf.items : [];
  return roundCents(items.reduce((s, it) => s + itemTotalQty(it) * (Number(it && it.unitCost) || 0), 0));
}

// A confirmation only becomes the pricing source of truth once it has real
// content — an empty sub-document (every order has one) must not zero totals.
function hasConfirmationContent(conf) {
  if (!conf) return false;
  const items = Array.isArray(conf.items) ? conf.items : [];
  const lines = Array.isArray(conf.customLines) ? conf.customLines : [];
  return items.length > 0 || lines.length > 0;
}

// Is the confirmation live on the client's link? The publish gate: content ALONE
// is not enough — the owner must have pushed it (confirmation.publishedAt set).
// This is the switch the PUBLIC page reads to move a client off the "we're
// finalizing" buffer into REVIEW+APPROVE. Owner-side views keep using
// hasConfirmationContent (they see the draft as it's built); only the client is
// gated. Totals/COGS still derive from content regardless of publish state, so
// the owner's own records are correct while the draft is still hidden.
function confirmationIsPublished(conf) {
  return hasConfirmationContent(conf) && !!(conf && conf.publishedAt);
}

// Total units of one confirmation item across its sizes.
function itemTotalQty(it) {
  return ((it && it.sizes) || []).reduce((s, sz) => s + (Number(sz.qty) || 0), 0);
}
// Units of one item assigned to destinations that STILL EXIST. We filter by the
// current shipTo keys (not every allocation blindly) so a stale allocation
// referencing a deleted location doesn't inflate the assigned count — this keeps
// the server's over-allocation check byte-identical to the builder
// (_shared allocatedQty) and the client-page "Unassigned" display, so the
// owner's WYSIWYG share-guard and the server backstop never disagree.
function itemAllocatedQty(it, shipTos) {
  const keys = new Set(((shipTos && Array.isArray(shipTos)) ? shipTos : []).map(s => s && s.key));
  return ((it && it.allocations) || [])
    .filter(a => a && keys.has(a.key))
    .reduce((s, a) => s + (Number(a.qty) || 0), 0);
}

// Pre-share gate: reasons a confirmation must NOT be sent to a client.
// Returns an array of human-readable issue strings (empty = OK to share). Used
// by the owner-side Share action AND mirrored in the builder UI. Two blocks:
//   1. NO PRICED LINE ITEMS / $0 TOTAL (H3) — a confirmation that grand-totals to
//      $0 (no priced sizes) is not a real order. Guarded on "no priced items /
//      empty", never on "merely small", so a legitimately deep-discounted total
//      with real priced items still passes.
//   2. OVER-ALLOCATED ITEM (C2) — once the order is split across shipTos, an item
//      whose per-location allocations EXCEED its own quantity is a broken split
//      and must never reach the client. (Under-allocation is allowed: the unsent
//      remainder shows as an explicit "Unassigned" row on the client page.)
// Only enforced when the confirmation actually has content — an empty
// confirmation isn't shareable for unrelated reasons and shouldn't surface a
// confusing "$0" message here.
function confirmationShareIssues(conf) {
  const issues = [];
  if (!hasConfirmationContent(conf)) return issues;
  const items = (conf && Array.isArray(conf.items)) ? conf.items : [];
  const pricedItems = items.filter(it => itemTotalQty(it) > 0 &&
    ((it.sizes || []).some(sz => (Number(sz.qty) || 0) > 0 && (Number(sz.unitPrice) || 0) > 0)));
  const grandTotal = computeConfirmationTotals(conf).grandTotal;
  if (pricedItems.length === 0 || grandTotal <= 0) {
    issues.push('This confirmation has no priced line items (the total is $0). Add quantities and unit prices before sharing.');
  }
  const shipTos = (conf && Array.isArray(conf.shipTos)) ? conf.shipTos : [];
  if (shipTos.length > 0) {
    items.forEach((it, i) => {
      const total = itemTotalQty(it);
      const allocated = itemAllocatedQty(it, shipTos);
      if (total > 0 && allocated > total) {
        const name = (it.productName || it.brandName || it.styleCode || `Item ${i + 1}`);
        issues.push(`"${name}" is over-allocated across locations (${allocated} of ${total} units assigned). Fix the per-location split before sharing.`);
      }
    });
  }
  return issues;
}

// A "real placed order" — the statuses that mark a company as an actual CUSTOMER
// (money committed, work underway/done). DELIBERATELY excludes the pre-sale
// statuses 'quoted' and 'approved' (still a quote/proposal) and 'cancelled' (no
// sale). isCustomer and the auto-promote-on-placement logic key off this set so
// "customer" means a verified placed order, never just a quote.
const PLACED_STATUSES = ['placed', 'in_production', 'shipped', 'delivered'];

// Processing-fee rates by payment method, as decimals. The single source of
// truth for the CC 2.99% / ACH 1% the client sees on the approval page and the
// confirmation PDF footer — never hardcode these percentages elsewhere.
const PAYMENT_FEES = { cc: 0.0299, ach: 0.01 };

const OrderSchema = new mongoose.Schema({
  projectNumber: { type: String, index: true },
  orderNumber:   { type: String, index: true },
  clientName:    { type: String, default: '', index: true },
  companyName:   { type: String, default: '', index: true },
  companyKey:    { type: String, default: '', index: true },
  // Which account owns this order — an AdminUser _id (string). '' = the owner's
  // (all legacy/owner-created orders). A sales agent's orders carry their id, so
  // agents see only their own and the owner's board isn't cluttered with theirs.
  agentId:       { type: String, default: '', index: true },
  status: {
    type: String,
    enum: ['quoted', 'approved', 'placed', 'in_production', 'shipped', 'delivered', 'cancelled'],
    default: 'quoted',
  },
  paid:          { type: Boolean, default: false },
  totalValue:    { type: Number, default: 0 },
  cogs:          { type: Number, default: 0 },
  printerName:   { type: String, default: '' },
  supplier:      { type: String, default: '' },
  shipToState:   { type: String, default: '' },  // quote-level destination state ("PA", "NY"); stays with the quote so re-quotes don't forget
  setupCost:     { type: Number, default: 0 },   // one-time setup fee (screens, digitizing, etc.) — flows into both COGS and client total
  shippingCost:  { type: Number, default: 0 },   // pass-through shipping
  notes:         { type: String, default: '' },
  confirmationMessage: { type: String, default: '' },  // personal note on the client-facing confirmation
  confirmationTerms:   { type: String, default: '' },  // payment / turnaround terms
  tasks: [{                                            // per-project checklist
    text:        { type: String, default: '' },
    done:        { type: Boolean, default: false },
    dueDate:     { type: Date,   default: null },
    completedAt: { type: Date,   default: null },
    _id: false,
  }],
  approvalToken:          { type: String, default: '' },  // random token used to gate public approval page
  approvalTokenExpiresAt: { type: Date,   default: null }, // null = never expires; non-null = strict cutoff
  // When admin re-shares the approval link with a fresh confirmation, we
  // bump approvalSupersededAt to "now". Any approvalEvents older than this
  // timestamp are treated as historical — the client lands on a fresh
  // approval ask, not the locked "you already approved" view. Approvals
  // history is preserved (still visible in the activity drawer), but the
  // gate logic only looks at events newer than supersededAt.
  approvalSupersededAt:   { type: Date,   default: null },
  // When the client submitted their option picks on the approval page (the
  // interactive quote stage). Cleared conceptually by a new approval cycle —
  // compare against approvalSupersededAt.
  optionsPickedAt:        { type: Date,   default: null },
  // How the client said they'll pay, captured on the approval page so the owner
  // knows the method (and its processing fee) at sign-off. '' = not chosen.
  // 'cc' carries a 2.99% processing fee; 'ach' carries 1%. This is a record of
  // the client's choice only — it does NOT mutate the confirmation's stored
  // totals (the owner still owns those via the confirmation custom lines); the
  // approval page shows the fee/adjusted total for transparency.
  paymentMethod:          { type: String, enum: ['', 'cc', 'ach'], default: '' },
  // Record that the client was shown — and, by approving, accepted — the brief
  // "approval is final" notice on the confirmation page. Stores the notice
  // VERSION string so future wording changes stay auditable; the acceptance
  // time is the approval time. '' = approved before the notice existed, or via
  // a legacy link that didn't carry it.
  approvalTermsVersion:    { type: String, default: '' },
  approvalTermsAcceptedAt: { type: Date,   default: null },
  approvalEvents: [{                                    // log of client interactions on the approval page
    kind:    { type: String },          // 'viewed' | 'approved' | 'requested_changes'
    message: { type: String, default: '' },
    by:      { type: String, default: '' },   // name the client optionally gave when acting
    email:   { type: String, default: '' },   // email the client optionally gave when acting
    at:      { type: Date, default: Date.now },
    _id: false,
  }],
  // Everyone the shared approval link has been emailed to. The link itself is a
  // single shared "hub" token — all recipients use the same URL — so this is
  // just the guest list, surfaced back in the admin Share dialog. Deduped by
  // email in the controller.
  approvalRecipients: [{
    email:  { type: String },
    sentAt: { type: Date, default: Date.now },
    _id: false,
  }],
  // General-purpose activity log. New event kinds (status changes, paid
  // toggles, files uploaded, etc.) land here as they get tracked. Render
  // in the drawer as a merged timeline with approvalEvents.
  activity: [{
    kind:    { type: String },          // 'created' | 'status_changed' | 'paid_changed' | 'duplicated_from' | 'file_uploaded' | 'mockups_linked'
    actor:   { type: String, default: 'admin' },        // 'admin' | 'client' | 'system'
    message: { type: String, default: '' },
    meta:    { type: mongoose.Schema.Types.Mixed, default: {} },
    at:      { type: Date,   default: Date.now },
    _id: false,
  }],

  // Final confirmation page — the operational doc sent to the client AFTER
  // they approve and pick a subset of the quote. Structure mirrors the user's
  // existing Excel template: header info, shipping, items with size breakdowns
  // and per-item mockup snapshot, plus custom add-on lines (shipping reserve,
  // CC fee, discounts, taxes).
  confirmation: {
    orderTitle:  { type: String, default: '' },
    orderDate:   { type: Date,   default: null },
    shipping: {
      name:         { type: String, default: '' },
      attention:    { type: String, default: '' },
      streetAddress:{ type: String, default: '' },
      cityStateZip: { type: String, default: '' },
    },
    // Optional multi-destination shipping. When EMPTY (the common case) the
    // order ships to the single `shipping` block above and nothing about the
    // doc, totals, PDF, or client page changes. When the client wants one
    // order split across several of their own locations, each destination is
    // captured here and items carry per-location `allocations` (below). Purely
    // additive — when empty, totals/PDF/finance are unchanged. When a location
    // sets a taxRate > 0, its allocated merchandise is taxed at that rate and
    // the sum is added to the grand total (see computeLocationTax).
    shipTos: [{
      key:          { type: String, default: '' },  // stable id linking allocations to this location
      label:        { type: String, default: '' },  // friendly name, e.g. "Brooklyn HQ"
      name:         { type: String, default: '' },  // ship-to company/recipient
      street:       { type: String, default: '' },
      cityStateZip: { type: String, default: '' },
      state:        { type: String, default: '' },  // USPS code; pre-fills taxRate from STATE_TAX_RATES
      taxRate:      { type: Number, default: 0 },    // sales-tax percent for this location (0 = untaxed)
      _id: false,
    }],
    items: [{
      mockupNum:           { type: String, default: '' },   // ref into project's saved mockups
      customMockupDataUrl: { type: String, default: '' },   // legacy single-image (kept for back-compat)
      mockupSnapshots: [{                                   // multiple variant images (e.g. headbands in 3 colors)
        dataUrl: { type: String, default: '' },
        label:   { type: String, default: '' },
        _id: false,
      }],
      showBack:            { type: Boolean, default: false },
      productName:         { type: String, default: '' },    // overrides brand+style label for non-garment items
      brandName:           { type: String, default: '' },
      styleCode:           { type: String, default: '' },
      printType:           { type: String, default: '' },
      printDetails:        { type: String, default: '' },    // decoration detail, e.g. "1 color front" — distinguishes a print variant (carried from the quote line)
      color:               { type: String, default: '' },
      // NJ exempts CLOTHING from sales tax — promo products (grinders, trays,
      // bags…) are taxable. Per-item so a mixed apparel+promo order taxes only
      // the promo slice. Seeded from an apparel-keyword guess in the builder;
      // the owner can flip it per item. computeLocationTax skips exempt items.
      taxExempt:           { type: Boolean, default: false },
      // Client-facing estimated turnaround for THIS item (carried from the
      // quote line the client picked) — shown on the confirmation they sign.
      turnaroundWeeks:     { type: Number, default: 0 },
      printerName:         { type: String, default: '' },    // who's actually printing this item
      unitCost:            { type: Number, default: 0 },     // internal cost/unit carried from the quote — drives the order's COGS, never shown to the client
      sizes: [{
        label:     { type: String, default: '' },  // 'XS', 'S', ..., 'OS', or any custom
        qty:       { type: Number, default: 0 },
        unitPrice: { type: Number, default: 0 },
        _id: false,
      }],
      // Per-location split of THIS item's total quantity, keyed to
      // confirmation.shipTos[].key. Optional and additive: when absent (every
      // single-location order, and any item the owner hasn't split) the item
      // ships whole to the single `shipping` address and nothing changes. The
      // allocations are a logistics overlay only — they never feed totals, tax,
      // revenue, or COGS, which stay driven purely by `sizes` (qty × unitPrice).
      allocations: [{
        key: { type: String, default: '' },  // matches a confirmation.shipTos[].key
        qty: { type: Number, default: 0 },    // units of this item going to that location
        _id: false,
      }],
      _id: false,
    }],
    // Add-on lines applied to the subtotal of all item sizes. Order matters
    // (discounts before tax, CC fee last, etc.). Each line is either a flat
    // amount or a percent of the running subtotal-so-far.
    customLines: [{
      label:     { type: String, default: '' },
      amount:    { type: Number, default: 0 },
      isPercent: { type: Boolean, default: false },
      // Marks a line as sales tax so the double-tax guard can drop it when
      // per-location tax is active (see isTaxCustomLine). Legacy/unflagged tax
      // lines are still caught by the /tax/i label fallback.
      isTax:     { type: Boolean, default: false },
      _id: false,
    }],
    // Fee model, now DERIVED from the lines (see hasBakedPaymentFee), not a switch:
    // if the owner baked a Card/ACH fee line the client sees no picker (the fee is in
    // the Total); if he baked none the client picks Card (2.99%) / ACH (1%) on the
    // approval page and that applies the fee once. This field is kept only as the
    // owner's remembered preference for the builder toggle; no money logic reads it.
    feeMode: { type: String, enum: ['owner_fee', 'client_choice'], default: 'client_choice' },
    // Publish gate (the "buffer"): the confirmation is INVISIBLE to the client
    // until the owner explicitly pushes it. Building/seeding/saving the doc never
    // shows it — the client stays on the "we're finalizing your order" screen —
    // so the owner can double-check the numbers before anything is committed.
    // Set by POST /orders/:id/confirmation/publish; the public page flips to
    // REVIEW+APPROVE only once this is non-null (see confirmationIsPublished).
    // null = draft (owner still finalizing). Existing pre-gate confirmations are
    // backfilled to their own updatedAt by scripts/backfillConfirmationPublished.js
    // so in-flight clients are never bounced back to the waiting screen.
    publishedAt: { type: Date, default: null },
  },
  // Client-facing order tracking timeline. Initialized the first time a
  // client approves a confirmation; admin then ticks off subsequent steps
  // from the Order Tracker tab and the client sees the same set of dates
  // on the approval link they already have. Steps are editable per-project
  // (rename, hide, add custom) since reality varies — e.g. when the blank
  // place and the printer are the same vendor those two steps collapse.
  tracking: {
    steps: [{
      id:          { type: String },              // stable key — 'confirmation_approved' etc for defaults, custom-* for added ones
      label:       { type: String, default: '' },
      completedAt: { type: Date,   default: null },
      note:        { type: String, default: '' },
      hidden:      { type: Boolean, default: false },
      // Optional URL — e.g. carrier tracking page for "Blanks shipping" or
      // "On the way to you". Rendered as a clickable button on the client
      // timeline under the step it belongs to.
      link:        { type: String, default: '' },
      _id: false,
    }],
  },

  mockupNumbers: [{ type: String }],
  // Mockup #s the owner explicitly REMOVED from this project. The client-name
  // auto-matcher (drawer + server auto-link) skips these, so an X actually
  // sticks instead of the mockup re-attaching itself. An explicit re-link via
  // the picker still wins — exclusion only blocks AUTO matching.
  excludedMockups: [{ type: String }],
  contactSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactSubmission', default: null },
  items: [{
    description: { type: String, default: '' },
    qty:         { type: Number, default: 0 },
    unitPrice:   { type: Number, default: 0 },
    _id: false,
  }],
  quoteLines: [{
    // Lines sharing a `group` label ("Bucket Hats") are alternative brand
    // options the client picks ONE of on the approval page. Ungrouped lines
    // are standalone (always included). `accepted` records the client's pick.
    group:        { type: String, default: '' },
    accepted:     { type: Boolean, default: false },
    // Stable line id — survives reorders/edits so the client's picks (made
    // against the PUSHED snapshot below) always map back to the right live
    // line. Minted/deduped server-side on every save (ensureQuoteLineIds).
    lid:          { type: String, default: '' },
    // Owner-only parking: a hidden line stays in the builder (costs, notes,
    // math) but never reaches the client page and never counts in totals.
    hiddenFromClient: { type: Boolean, default: false },
    // The design the client signs off when picking this option: a studio
    // mockup number, and/or an uploaded image (data URL or hosted URL) for
    // items the vendor renders externally — glass ashtrays etc. have no
    // mockup number.
    mockupNum:    { type: String, default: '' },
    image:        { type: String, default: '' },
    qty:          { type: Number, default: 0 },
    styleCode:    { type: String, default: '' },
    description:  { type: String, default: '' },
    color:        { type: String, default: '' },
    supplier:     { type: String, default: '' },
    // Public product page for THIS blank (e.g. an S&S Activewear /p/ URL) so a
    // client comparing brands can click through to specs/colors. Deliberately a
    // CLIENT-VISIBLE exception to the "supplier stays internal" rule — the
    // owner sets it per line, and supplier PRICING never rides along (S&S gates
    // wholesale prices behind login). Exposed publicly as `productUrl`.
    supplierUrl:  { type: String, default: '' },
    blankCost:    { type: Number, default: 0 },   // per unit
    printType:    { type: String, default: '' },  // e.g. "Screen Print", "DTG", "Embroidery"
    printDetails: { type: String, default: '' },  // e.g. "1 color front + 2 color back"
    printCost:    { type: Number, default: 0 },   // per unit
    setupCost:    { type: Number, default: 0 },   // full one-time setup for THIS option; spread across this line's qty
    shippingCost: { type: Number, default: 0 },   // full shipping for THIS option; spread across this line's qty
    markup:       { type: Number, default: 1.4 }, // multiplier; unit price = (blankCost + printCost + (setup+ship)/qty) * markup; matches the builder default
    noMarkup:     { type: Boolean, default: false }, // promo/vendor-catalog price already includes margin — un-typed cells auto-fill at COST (×1), not ×1.4. COGS unaffected.
    unitPrice:    { type: Number, default: 0 },   // computed but stored so user can override
    // Optional client-facing lead time for THIS option, in weeks. 0 = not set
    // (the quote/approval page shows nothing). Purely informational — never
    // affects pricing/COGS. Per-line so a "quick print" option can quote a
    // shorter turnaround than a "full print" one in the same group.
    turnaroundWeeks: { type: Number, default: 0 },
    _id: false,
  }],
  // The quote the CLIENT currently sees. Autosave keeps editing quoteLines
  // freely; the public approval page serves this snapshot once it exists, so
  // mid-edit numbers never flash at the client. "Push update" (and sharing
  // the link) copies quoteLines → here. Null/absent = legacy behavior (live).
  quoteLinesPublished: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  quotePushedAt:       { type: Date, default: null },
  orderDate:     { type: Date },
  shipDate:      { type: Date },
  deliveredDate: { type: Date },
  importedFrom:  { type: String, default: '' },

  // Soft-delete (mirrors Client). An order is NEVER hard-deleted by the reconcile
  // tooling: a mis-staged / bad-import order is archived (drops out of working
  // surfaces) with all data preserved and restorable. Set by the reconcile
  // service when undoing a bad import.
  archived:       { type: Boolean, default: false, index: true },
  archivedAt:     { type: Date, default: null },
  archivedReason: { type: String, default: '' },     // 'bad-import', 'meta-ad-import', 'manual'
  // Reconcile audit/revert handle — the run that created or archived this order,
  // so a whole reconcile batch is reversible as a unit. Empty if untouched.
  reconcileBatchId: { type: String, default: '', index: true },
  files: [{
    filename:     { type: String },
    originalName: { type: String },
    mimetype:     { type: String },
    size:         { type: Number },
    uploadedAt:   { type: Date, default: Date.now },
    _id: false,
  }],
}, { timestamps: true });

// Totals lifecycle — one source of truth per stage:
//   - Quote stage (no confirmation content): totalValue/cogs derive from
//     quoteLines, so every surface (card / dashboard) agrees with the quote.
//   - Confirmation stage: the confirmation is the real order — its grand total
//     (what the client actually approves) becomes totalValue, and its items'
//     qty × unitCost becomes cogs. Quote-derived cogs survives only when the
//     confirmation predates the unitCost field (computeConfirmationCogs → 0),
//     so a legacy doc can never zero out a real estimate.
// Recomputes are gated on the fields actually changing, so unrelated saves
// (approval-token rotation, tracking ticks) can't clobber a hand-corrected
// total.
// Every quote line carries a unique stable `lid` — the pick-mapping handle
// between the published snapshot and the live lines. Minted where missing;
// duplicates (a grid row copied with {...spread}) keep the FIRST and re-mint
// the rest. Mutates in place; safe on subdocs and plain objects alike.
function ensureQuoteLineIds(lines) {
  const seen = new Set();
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l) continue;
    if (!l.lid || seen.has(l.lid)) l.lid = crypto.randomBytes(8).toString('hex');
    seen.add(l.lid);
  }
  return lines;
}

OrderSchema.pre('save', function (next) {
  this.companyKey = deriveCompanyKey(this.companyName, this.clientName);
  const lines = Array.isArray(this.quoteLines) ? this.quoteLines : [];
  if (this.isNew || this.isModified('quoteLines')) ensureQuoteLineIds(lines);
  // On brand-new docs only react to actual content — imports and manual
  // creates carry a hand-set totalValue with no quote lines, and the old
  // length>0 guard kept those intact.
  const quoteTouched = this.isNew ? lines.length > 0 : this.isModified('quoteLines');
  const confTouched  = this.isNew
    ? hasConfirmationContent(this.confirmation)
    : this.isModified('confirmation');
  if (quoteTouched) {
    const t = computeQuoteTotals(lines, this.setupCost, this.shippingCost);
    this.cogs = t.cogs;
    if (!hasConfirmationContent(this.confirmation)) this.totalValue = t.totalValue;
  }
  if ((confTouched || quoteTouched) && hasConfirmationContent(this.confirmation)) {
    this.totalValue = computeConfirmationTotals(this.confirmation).grandTotal;
    const confCogs = computeConfirmationCogs(this.confirmation);
    if (confCogs > 0) this.cogs = confCogs;
  }
  next();
});

OrderSchema.pre('findOneAndUpdate', async function () {
  const u = this.getUpdate() || {};
  const set = u.$set || u;
  // Re-derive the join key when the name changes — UNLESS the caller passed an
  // explicit companyKey (an established order keeping its identity stable on a
  // display-name edit, or a deliberate merge). Without this guard, renaming one
  // project silently re-keyed it and orphaned it from its company's other orders,
  // finance rollup, and CRM record.
  if ((set.companyName !== undefined || set.clientName !== undefined) && set.companyKey === undefined) {
    set.companyKey = deriveCompanyKey(set.companyName, set.clientName);
  }
  if (Array.isArray(set.quoteLines)) {
    ensureQuoteLineIds(set.quoteLines);
    const t = computeQuoteTotals(set.quoteLines, set.setupCost, set.shippingCost);
    set.cogs = t.cogs;
    // The confirmation total stays authoritative if one exists — look it up
    // when this update doesn't carry it.
    let conf = set.confirmation;
    if (conf === undefined) {
      const doc = await this.model.findOne(this.getQuery()).select('confirmation').lean();
      conf = doc && doc.confirmation;
    }
    if (hasConfirmationContent(conf)) {
      set.totalValue = computeConfirmationTotals(conf).grandTotal;
      const confCogs = computeConfirmationCogs(conf);
      if (confCogs > 0) set.cogs = confCogs;
    } else {
      set.totalValue = t.totalValue;
    }
  } else if (set.confirmation !== undefined && hasConfirmationContent(set.confirmation)) {
    set.totalValue = computeConfirmationTotals(set.confirmation).grandTotal;
    const confCogs = computeConfirmationCogs(set.confirmation);
    if (confCogs > 0) set.cogs = confCogs;
  }
  if (u.$set) u.$set = set; else Object.assign(u, set);
  this.setUpdate(u);
});

module.exports = mongoose.model('Order', OrderSchema);
module.exports.PLACED_STATUSES = PLACED_STATUSES;
module.exports.PAYMENT_FEES = PAYMENT_FEES;
module.exports.deriveCompanyKey = deriveCompanyKey;
module.exports.computeQuoteTotals = computeQuoteTotals;
module.exports.ensureQuoteLineIds = ensureQuoteLineIds;
module.exports.computeConfirmationTotals = computeConfirmationTotals;
module.exports.computeConfirmationCogs = computeConfirmationCogs;
module.exports.computeLocationTax = computeLocationTax;
module.exports.STATE_TAX_RATES = STATE_TAX_RATES;
module.exports.hasConfirmationContent = hasConfirmationContent;
module.exports.confirmationIsPublished = confirmationIsPublished;
module.exports.confirmationShareIssues = confirmationShareIssues;
module.exports.isTaxCustomLine = isTaxCustomLine;
module.exports.isPaymentFeeCustomLine = isPaymentFeeCustomLine;
module.exports.hasBakedPaymentFee = hasBakedPaymentFee;
module.exports.roundCents = roundCents;
