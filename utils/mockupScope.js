// utils/mockupScope.js
//
// One rule for "which slice of the mockup library does this order care about?".
//
// Six separate code paths used to answer that with `find({ store: 'mockups' })` —
// the WHOLE collection — then build an in-memory index to pull out two or three
// items. That runs on every public approval page view, every client portal load,
// every confirmation PDF and every PO email, and it grows with every mockup the
// business ever makes. There are indexes for exactly this
// ({ store, companyKey, savedAt } and { store, projectNumber, savedAt }); this
// helper is what finally uses them.
//
// Preference: the client (a mockup referenced by a confirmation may legitimately
// have been carried over from an earlier project of the SAME client, so scoping
// to one project would drop it) → else the project → else, for a legacy record
// carrying neither key, the old unscoped behaviour so nothing silently breaks.
//
// That preference is now a UNION, not an either/or — see clientLibraryScopeFor
// below for why. (The companyKey-only version it replaced is gone rather than
// deprecated: leaving two nearly-identical scope rules side by side is how a
// surface ends up on the subtly stricter one by accident, which is the bug this
// file exists to prevent.)

// The strict per-project slice — the isolation boundary the client sees. Returns
// null when the order has no project number to scope by (an empty shell), so
// callers can choose to show nothing rather than everything.
function projectScopeFor(order) {
  if (!order || order.projectNumber == null || String(order.projectNumber) === '') return null;
  return { store: 'mockups', projectNumber: String(order.projectNumber) };
}

// The slice a CLIENT-FACING surface must load for one order: this client's
// library UNION this project's designs.
//
// Scoping by companyKey alone is right for resolving a confirmation's references
// (a carried-over design of the same client). But it
// silently loses a mockup that carries the PROJECT link and not the client one —
// and those exist: a doc created by a path that stamps neither key is unreachable
// until the boot backfill catches it, so for the hours in between the client's
// link showed fewer designs than the owner's project panel. An $or over the two
// keys costs nothing (both are indexed, { store, companyKey, savedAt } and
// { store, projectNumber, savedAt }) and neither key can hide the other.
function clientLibraryScopeFor(order) {
  const companyKey = order && order.companyKey ? String(order.companyKey) : '';
  const projectNumber = order && order.projectNumber != null ? String(order.projectNumber) : '';
  if (companyKey && projectNumber) {
    return { store: 'mockups', $or: [{ companyKey }, { projectNumber }] };
  }
  if (companyKey) return { store: 'mockups', companyKey };
  if (projectNumber) return { store: 'mockups', projectNumber };
  return { store: 'mockups' };
}

// The project a mockup claims. The top-level field is the real link; the
// pageState blob is where that link lived before the field existed, and a doc
// written straight to the collection (the "Add a variation" clone) or synced by
// an older studio carries only the blob until backfillProjectNumbers promotes it
// at the next boot. The Studio's own Designs panel reads both — so a client
// surface that reads only the field is STRICTER than the panel it mirrors, which
// is precisely how a design the owner can see goes missing from the client link.
function mockupProjectNumber(item) {
  if (!item) return '';
  const top = String(item.projectNumber || '').trim();
  if (top) return top;
  return String((item.pageState && item.pageState.projectNumber) || '').trim();
}

// Does this mockup belong to this project? False for an order with no project
// number — an empty shell has no slice to show, and matching '' against every
// unlinked mockup in the library is exactly the leak this boundary prevents.
function belongsToProject(item, projectNumber) {
  const want = String(projectNumber == null ? '' : projectNumber).trim();
  if (!want) return false;
  return mockupProjectNumber(item) === want;
}

module.exports = {
  projectScopeFor,
  clientLibraryScopeFor,
  mockupProjectNumber,
  belongsToProject,
};
