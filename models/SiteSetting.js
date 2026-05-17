// models/SiteSetting.js
//
// Generic key/value store for site-wide settings the admin needs to edit
// without re-deploying. First user: the catalog page toast (headline, code,
// subtext, accent color, enabled flag). Future uses: any other publicly-
// readable config the studio should control.
//
// `value` is Mixed because the shape differs per key. Keep that in mind when
// reading — the controller validates on write so reads can trust the shape.
const mongoose = require('mongoose');

const SiteSettingSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true, index: true },
  value:     { type: mongoose.Schema.Types.Mixed },
  updatedAt: { type: Date, default: Date.now },
});

SiteSettingSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('SiteSetting', SiteSettingSchema);
