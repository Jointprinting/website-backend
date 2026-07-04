// middleware/auth.js
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set in env — studio auth will fail until you set it.');
}

// Verify the Bearer token and attach the caller. Sets both req.user (the new
// role-aware identity) and req.adminUser (legacy alias) so existing handlers keep
// working. Legacy tokens (no role claim) resolve to 'owner' — they were only ever
// issued to the single owner account. No role gate here.
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
      role: decoded.role || 'owner',   // legacy tokens = the owner
      userId: decoded.uid || null,
      scope: decoded.scope,
    };
    req.user = identity;
    req.adminUser = identity;          // backward-compat for existing handlers
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
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

module.exports = { requireAuth, requireOwner, requireAdmin };
