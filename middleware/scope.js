// middleware/scope.js
//
// Ownership scoping for the multi-user Studio (owner + sales agents). Every Order
// and Client carries an `agentId` — an AdminUser _id string; '' means the OWNER's
// (all legacy/owner records). These pure helpers turn the authenticated caller
// (req.user, set by requireAuth) into the Mongo filter of what they may SEE and
// the id to STAMP on what they create. Pure + unit-tested — no DB, no Express.

// The filter restricting a query to what the caller may see.
//   • agent → HARD-LOCKED to their own id; they can never widen it.
//   • owner → their OWN records by default (agentId '' or the owner's own id), so
//     the owner's board isn't fluffed with agents' work. Query overrides (owner
//     only): ?agentId=<id> views one agent, ?agentId=all shows everything.
function visibleFilter(req) {
  const user = (req && req.user) || {};
  const uid = String(user.userId || '');
  if (user.role === 'agent') return { agentId: uid };
  const q = (req && req.query) || {};
  const want = q.agentId != null ? String(q.agentId) : '';
  if (want === 'all') return {};                          // owner: everything
  if (want && want !== 'me') return { agentId: want };    // owner: one agent's
  // owner: own + legacy. `null` in the $in also matches docs written BEFORE the
  // agentId field existed (missing field), so pre-agents records are never hidden
  // from the owner when this filter is applied.
  return { agentId: { $in: ['', uid, null] } };
}

// The agentId to STAMP on a record the caller creates. Owner-created records stay
// '' (the legacy convention, so the owner's data is uniform); an agent's carry
// their id.
function stampFor(req) {
  const user = (req && req.user) || {};
  return user.role === 'agent' ? String(user.userId || '') : '';
}

// May the caller read/write this specific doc? Owner (or a legacy owner token):
// always. Agent: only their own record — never the owner's or another agent's.
function canAccessDoc(req, doc) {
  const user = (req && req.user) || {};
  if (!doc) return false;
  if (user.role !== 'agent') return true;
  return String(doc.agentId || '') === String(user.userId || '');
}

// True when the caller is a restricted agent (convenience for controllers).
function isAgent(req) {
  return !!(req && req.user && req.user.role === 'agent');
}

module.exports = { visibleFilter, stampFor, canAccessDoc, isAgent };
