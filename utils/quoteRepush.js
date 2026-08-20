'use strict';

// ── Re-pushing a quote must not silently re-price what the client agreed to ──
//
// The builder autosaves quoteLines constantly; "Push to client" (and sharing a
// link, which is also a push) is the moment those edits reach the client's page.
//
// Nothing checked whether the edits changed an option the client had ALREADY
// accepted. So: the client picks option B at 100 units for $1,200 and the line
// is marked accepted. The owner later corrects that line to 150 units at $1,450
// and pushes. The acceptance flag stays on, and the order now records the client
// as having accepted something they never saw, at a price they never agreed to —
// and because `accepted` is what computeQuoteTotals bills off, the money follows
// the new number silently.
//
// The lifecycle MONEY_LOCKED guard in updateOrder does not cover this: it locks
// the confirmation once approved, not the quote before it.
//
// So a push clears the acceptance on any line whose CLIENT-FACING terms moved.
// Clearing rather than blocking, deliberately — the owner should be able to
// correct a quote and re-send it; what he should not be able to do is re-send it
// while it still claims a yes.

// Everything the client actually saw and agreed to. Internal economics —
// blankCost, printCost, markup, printerKey, supplier, notes — are NOT here: the
// owner re-costing his own side of a line is not a change to the client's offer
// and must not throw away their pick.
function clientTerms(l) {
  const s = (v) => String(v == null ? '' : v).trim();
  const n = (v) => (Number(v) || 0);
  return JSON.stringify({
    group: s(l && l.group),
    qty: n(l && l.qty),
    unitPrice: n(l && l.unitPrice),
    description: s(l && l.description),
    styleCode: s(l && l.styleCode),
    color: s(l && l.color),
    printType: s(l && l.printType),
    printDetails: s(l && l.printDetails),
    // A promise, not a price, but a 2-week job becoming a 6-week one is
    // absolutely a change to what they said yes to.
    turnaroundWeeks: n(l && l.turnaroundWeeks),
    // The colours on offer, and the price breaks they can reach.
    colorOptions: ((l && l.colorOptions) || []).map((c) => s(c && c.name)).sort(),
    hiddenFromClient: !!(l && l.hiddenFromClient),
  });
}

// Which accepted lines a push would invalidate. PURE — `lines` are the live
// lines about to be published, `published` the previous snapshot.
// Returns { stale: [lid], reasons: [{ lid, description }] }.
function staleAcceptances(lines, published) {
  const before = new Map(
    (Array.isArray(published) ? published : [])
      .filter((l) => l && l.lid)
      .map((l) => [String(l.lid), clientTerms(l)]),
  );
  const stale = [];
  const reasons = [];
  for (const l of (Array.isArray(lines) ? lines : [])) {
    // Standalone lines carry no client decision — they are always part of the
    // order, so there is no "yes" to invalidate.
    if (!l || !l.accepted || !l.group || !l.lid) continue;
    const prev = before.get(String(l.lid));
    // No previous snapshot for this line means it was accepted against
    // something we can't compare — leave it alone rather than guess.
    if (prev === undefined) continue;
    if (prev === clientTerms(l)) continue;
    stale.push(String(l.lid));
    reasons.push({ lid: String(l.lid), description: String((l.description || l.styleCode || 'an option')).trim() });
  }
  return { stale, reasons };
}

// Apply it: drop the acceptance and everything that hung off it. Mutates
// `lines` and returns the reasons, so the caller can log what it undid.
//
// colorSplit and pickedQty go too. They are the client's ANSWER to the offer
// that just changed, and leaving them behind would keep billing an allocation
// against a line whose quantities or colours no longer match it.
function clearStaleAcceptances(lines, published) {
  const { stale, reasons } = staleAcceptances(lines, published);
  if (!stale.length) return reasons;
  const drop = new Set(stale);
  for (const l of lines) {
    if (!l || !l.lid || !drop.has(String(l.lid))) continue;
    l.accepted = false;
    if ((l.colorSplit || []).length) l.colorSplit = [];
    if (Number(l.pickedQty) > 0) l.pickedQty = 0;
  }
  return reasons;
}

// Once nothing grouped is accepted any more, the client is back at the picker —
// so the "they've chosen" stamp has to come off too, or the Studio keeps
// showing a project as picked while its client page asks the question again.
function stillPicked(lines) {
  return (Array.isArray(lines) ? lines : []).some((l) => l && l.group && l.accepted);
}

module.exports = { clientTerms, staleAcceptances, clearStaleAcceptances, stillPicked };
