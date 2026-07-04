// controllers/auth.js
//
// Studio (admin) login. Password is hashed with bcrypt and stored
// in the AdminUser collection — see scripts/setStudioPassword.js for
// the one-time setup command.

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const AdminUser = require('../models/AdminUser');

const JWT_SECRET = process.env.JWT_SECRET;
// Studio session lifetime. Shortened from 30d → 7d to limit the blast radius of a
// leaked token (there is still no per-token revocation — see the multi-user auth
// follow-up). Override with STUDIO_TOKEN_TTL (any `jsonwebtoken` expiresIn string,
// e.g. '12h', '7d'). A logged-in owner is simply re-prompted weekly.
const TOKEN_TTL = process.env.STUDIO_TOKEN_TTL || '7d';
const MAX_FAILED = 5;
const LOCKOUT_MINUTES = 15;

// The owner is always the 'studio' account; any other account is an agent. We
// resolve role from BOTH the username and any stored role so a legacy 'studio'
// row (created before roles existed, its role defaulting to 'agent') is still
// treated — and self-healed — as the owner. Pure + unit-tested.
function resolveRole(user) {
  return (user.username === 'studio' || user.role === 'owner') ? 'owner' : 'agent';
}

// GENERIC failure so a probing attacker can't tell "no such user" from "wrong
// password" (username enumeration). Same message, same 401, for both.
const BAD_LOGIN = 'Invalid username or password.';

// A throwaway bcrypt hash we compare against when the username doesn't exist, so
// an unknown user costs the SAME ~250ms as a real one — no fast-path timing tell.
// Computed once at boot.
const DUMMY_HASH = bcrypt.hashSync('unused-timing-equalizer-password', 12);

exports.studioLogin = async (req, res) => {
  try {
    const body = req.body || {};
    // username+password. A missing username defaults to 'studio' so the owner's
    // existing password-only client keeps working through the UI transition.
    const username = String(body.username || 'studio').trim().toLowerCase();
    const { password } = body;
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ message: 'Password is required.' });
    }

    const user = await AdminUser.findOne({ username });

    // Per-account lockout after repeated failures (real accounts only).
    if (user && user.lockedUntil && user.lockedUntil > new Date()) {
      const minsLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return res.status(429).json({ message: `Too many failed attempts. Try again in ${minsLeft} min.` });
    }

    // ALWAYS run bcrypt — against a dummy hash when the user doesn't exist — so an
    // unknown username costs the same time as a wrong password (no timing oracle).
    const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) {
      if (user) {
        user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
        if (user.failedLoginAttempts >= MAX_FAILED) {
          user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
          user.failedLoginAttempts = 0;
        }
        await user.save();
      } else if (username === 'studio' && (await AdminUser.countDocuments()) === 0) {
        // First-run hint only when NOTHING is set up (no enumeration risk then).
        return res.status(401).json({
          message: "Studio password isn't set up yet. Run `npm run set-studio-password` on the server.",
        });
      }
      return res.status(401).json({ message: BAD_LOGIN });
    }

    // Password is correct. Only NOW — behind a proven password, so it's not an
    // enumeration oracle — tell a disabled account why it can't get in.
    if (user.active === false) {
      return res.status(403).json({ message: 'This account is disabled. Ask the owner to re-enable it.' });
    }

    // Success — reset counters, self-heal the role, count the login.
    const role = resolveRole(user);
    user.failedLoginAttempts = 0;
    user.lockedUntil = null; // null (not undefined) so the clear persists
    user.lastLoginAt = new Date();
    user.loginCount = (user.loginCount || 0) + 1;
    if (user.role !== role) user.role = role;
    await user.save();

    const token = jwt.sign(
      { sub: user.username, role, uid: String(user._id), scope: 'studio' },
      JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    return res.json({
      token, expiresIn: TOKEN_TTL, role,
      username: user.username, displayName: user.displayName || '',
    });
  } catch (err) {
    console.error('studioLogin error:', err);
    return res.status(500).json({ message: 'Login failed.' });
  }
};

exports.verifyToken = (req, res) => {
  // requireAuth middleware has already verified the token by the time we get here.
  const u = req.user || req.adminUser || {};
  return res.json({ ok: true, username: u.username, role: u.role || 'owner', displayName: u.displayName || '' });
};

// Exported for unit tests (pure role resolution).
exports.resolveRole = resolveRole;
