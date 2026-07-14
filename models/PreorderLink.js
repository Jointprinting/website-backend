// models/PreorderLink.js
//
// A PREORDER LINK — an expiring public page (/preorder/<token>) where a
// client's people commit to quantities BEFORE the run is placed: names and
// counts, never payments. The owner mints one per drop (usually against a
// project), sends a single URL, and watches the tally roll up in the Studio.
// Revoke clears nothing — it just closes the door (house rule: no deletes).

const mongoose = require('mongoose');

const commitmentSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  contact: { type: String, default: '', trim: true },   // phone or email, their choice
  itemId:  { type: String, required: true },
  size:    { type: String, default: '' },
  qty:     { type: Number, required: true, min: 1 },
  note:    { type: String, default: '', trim: true },
  at:      { type: Date, default: Date.now },
}, { _id: true });

const preorderLinkSchema = new mongoose.Schema({
  token:   { type: String, required: true, unique: true, index: true },
  // Ecosystem links — same identifiers the rest of the Studio rides on.
  companyKey:    { type: String, default: '', index: true },
  projectNumber: { type: String, default: '' },
  orderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  title: { type: String, required: true, trim: true },
  note:  { type: String, default: '', trim: true },
  // What people commit to. Sizes optional (promo items have none).
  items: [{
    id:    { type: String, required: true },
    label: { type: String, required: true, trim: true },
    sizes: { type: [String], default: [] },
  }],
  expiresAt: { type: Date, default: null },   // null = open until revoked
  revokedAt: { type: Date, default: null },
  commitments: { type: [commitmentSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

// A link is open for commitments only while un-revoked and un-expired.
preorderLinkSchema.methods.isOpen = function isOpen() {
  if (this.revokedAt) return false;
  if (this.expiresAt && new Date(this.expiresAt).getTime() < Date.now()) return false;
  return true;
};

module.exports = mongoose.model('PreorderLink', preorderLinkSchema);
