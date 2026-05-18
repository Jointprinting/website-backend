// models/DispensaryDenylist.js
//
// Google Places search for "dispensary" returns false positives — smoke
// shops, vape stores, CBD-only places that aren't recreational cannabis.
// This collection holds Google place_ids the admin has flagged as "ignore
// this one, it's not a real dispensary." Filtered out server-side before
// results reach the frontend.
//
// State licensed-retailer lists (Plan A) is the better long-term answer for
// the cross-country trip — this denylist is the band-aid for the East Coast
// test trip using Plan B (Google Places + manual cleanup).

const mongoose = require('mongoose');

const DispensaryDenylistSchema = new mongoose.Schema({
  placeId: { type: String, required: true, unique: true, index: true },
  name:    { type: String, default: '' }, // captured for the admin's reference
  reason:  { type: String, default: '' }, // e.g. "smoke shop", "CBD only"
  addedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('DispensaryDenylist', DispensaryDenylistSchema);
