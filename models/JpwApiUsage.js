// models/JpwApiUsage.js
//
// Per-day usage counters for the JPW recon engine. One document per
// calendar day (YYYY-MM-DD). Used by jpwPlacesIngest to enforce a daily
// Places API call cap, and by the audit endpoint to surface usage in
// the admin dashboard.
//
// Why a model instead of an in-memory counter: Render restarts the dyno
// regularly; a memory counter would forget the day's usage. A tiny Mongo
// doc per day costs ~nothing and survives restarts.

const mongoose = require('mongoose');

const JpwApiUsageSchema = new mongoose.Schema({
  date:          { type: String, required: true, unique: true }, // YYYY-MM-DD
  places_calls:  { type: Number, default: 0 },
  audits_run:    { type: Number, default: 0 },
  created_at:    { type: Date, default: Date.now },
});

module.exports = mongoose.model('JpwApiUsage', JpwApiUsageSchema);
