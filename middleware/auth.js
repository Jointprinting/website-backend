// middleware/auth.js
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set in env — studio auth will fail until you set it.');
}

/**
 * Express middleware that requires a valid Bearer token.
 * On success, sets req.adminUser = { username }.
 */
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ message: 'Missing or malformed Authorization header.' });
  }

  try {
    const decoded = jwt.verify(match[1], JWT_SECRET);
    req.adminUser = { username: decoded.sub, scope: decoded.scope };
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

module.exports = { requireAdmin };
