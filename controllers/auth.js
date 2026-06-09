// controllers/auth.js
//
// Studio (admin) login. Password is hashed with bcrypt and stored
// in the AdminUser collection — see scripts/setStudioPassword.js for
// the one-time setup command.

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const AdminUser = require('../models/AdminUser');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.STUDIO_TOKEN_TTL || '30d';
const MAX_FAILED = 5;
const LOCKOUT_MINUTES = 15;

exports.studioLogin = async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ message: 'Password is required.' });
    }

    // Single-user studio: there should only be one row, default username "studio".
    const user = await AdminUser.findOne({ username: 'studio' });
    if (!user) {
      return res.status(401).json({
        message:
          "Studio password isn't set up yet. Run `npm run set-studio-password` on the server.",
      });
    }

    // Lockout check
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minsLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return res.status(429).json({
        message: `Too many failed attempts. Try again in ${minsLeft} min.`,
      });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= MAX_FAILED) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
        user.failedLoginAttempts = 0;
      }
      await user.save();
      return res.status(401).json({ message: 'Wrong password.' });
    }

    // Success — reset counters
    user.failedLoginAttempts = 0;
    // null (not undefined) — assigning undefined to a Mongoose path doesn't
    // reliably persist the clear.
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    await user.save();

    const token = jwt.sign(
      { sub: user.username, scope: 'studio' },
      JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    return res.json({ token, expiresIn: TOKEN_TTL });
  } catch (err) {
    console.error('studioLogin error:', err);
    return res.status(500).json({ message: 'Login failed.' });
  }
};

exports.verifyToken = (req, res) => {
  // requireAdmin middleware has already verified the token by the time we get here.
  return res.json({ ok: true, username: req.adminUser.username });
};
