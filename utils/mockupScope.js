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

function mockupScopeFor(order) {
  if (order && order.companyKey) {
    return { store: 'mockups', companyKey: order.companyKey };
  }
  if (order && order.projectNumber != null && String(order.projectNumber) !== '') {
    return { store: 'mockups', projectNumber: String(order.projectNumber) };
  }
  return { store: 'mockups' };
}

// The strict per-project slice — the isolation boundary the client sees. Returns
// null when the order has no project number to scope by (an empty shell), so
// callers can choose to show nothing rather than everything.
function projectScopeFor(order) {
  if (!order || order.projectNumber == null || String(order.projectNumber) === '') return null;
  return { store: 'mockups', projectNumber: String(order.projectNumber) };
}

module.exports = { mockupScopeFor, projectScopeFor };
