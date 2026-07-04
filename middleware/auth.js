// middleware/auth.js
const jwt = require('jsonwebtoken');
const AdminUser = require('../models/AdminUser');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set in env — studio auth will fail until you set it.');
}

// Resolve the caller's role from the token WITHOUT failing open. A present role
// claim wins. A role-less token is a legacy OWNER token only if it carries the
// 'studio' subject (that's the sole account that ever got one); anything else
// defaults to the LEAST-privileged 'agent'. This closes the old fail-open where a
// missing role silently became 'owner'.
function roleFrom(decoded) {
  if (decoded.role === 'owner' || decoded.role === 'agent') return decoded.role;
  return decoded.sub === 'studio' ? 'owner' : 'agent';
}

// Verify the Bearer token and attach the caller. Sets both req.user (the new
// role-aware identity) and req.adminUser (legacy alias) so existing handlers keep
// working. No role gate here.
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ message: 'Missing or malformed Authorization header.' });
  }
  try {
    const decoded = jwt.verify(match[1], JWT_SECRET);
    const identity = {
      username: decoded.sub,
      role: roleFrom(decoded),
      userId: decoded.uid || null,
      scope: decoded.scope,
      iat: decoded.iat || 0,           // issued-at (seconds) — for session revocation
    };
    req.user = identity;
    req.adminUser = identity;          // backward-compat for existing handlers
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

// Session revocation for AGENTS. requireAuth trusts the signed token, but an
// agent's token lives for the whole TTL — so a fired/paused agent (or one whose
// password the owner just reset) would keep access until it expired. This gate,
// applied to the agent portal, re-checks the live account on every request: it
// refuses a missing/disabled account, and refuses any token issued before the
// account's credentialsChangedAt stamp (bumped on disable + password reset). The
// owner is never loaded here — their hot paths stay lookup-free.
async function requireActiveAgent(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      if (req.user.role !== 'agent') return next(); // owner: nothing to revoke here
      const user = await AdminUser.findById(req.user.userId).select('active credentialsChangedAt');
      if (!user || user.active === false) {
        return res.status(401).json({ message: 'This account is no longer active. Please sign in again.' });
      }
      if (user.credentialsChangedAt && (req.user.iat * 1000) < user.credentialsChangedAt.getTime()) {
        return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
      }
      return next();
    } catch (e) {
      return res.status(500).json({ message: 'Auth check failed.' });
    }
  });
}

// OWNER-only gate: valid token AND role 'owner'. Protects the whole admin surface
// (finances, vendors, outreach, agent management…). requireAdmin is kept as an
// alias so every route currently using it stays owner-only with NO change —
// agents are opened into specific routes (Orders/CRM) deliberately later, via
// requireAuth + in-controller scoping, never by loosening this gate.
function requireOwner(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Owner access required.' });
    }
    return next();
  });
}

const requireAdmin = requireOwner;

module.exports = { requireAuth, requireOwner, requireAdmin, requireActiveAgent, roleFrom };
