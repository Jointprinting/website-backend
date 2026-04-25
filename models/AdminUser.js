// models/AdminUser.js
//
// One row per admin/studio user. We expect a single row in this collection
// (you), but the model is generalized in case Nate decides to add staff later.

const mongoose = require('mongoose');

const AdminUserSchema = new mongoose.Schema({
  username: {
    type: String,
    default: 'studio',
    unique: true,
    required: true,
  },
  passwordHash: {
    type: String,
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date },
});

module.exports = mongoose.model('AdminUser', AdminUserSchema);
