// models/DispensaryDensityCache.js
//
// Coarse-grid cache for the "validate area" / "denser nearby" tool. We snap
// search centers to a ~3.5mi grid (0.05° at mid-latitudes) so re-panning
// within a neighborhood reuses the same cell and we don't re-bill Google.
//
// TTL is 7 days — long enough to make a two-week trip basically free after
// the first round of validations, short enough that dispensary
// openings/closings get picked up between trips. The admin UI can also
// delete a single cell to force a re-fetch.

const mongoose = require('mongoose');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const DispensaryDensityCacheSchema = new mongoose.Schema({
  // Composite key: "lat:40.85|lng:-74.05|r:20mi". Lat/lng snapped to 0.05°,
  // radius bucketed into {5mi, 10mi, 20mi}.
  cellKey:    { type: String, required: true, unique: true, index: true },

  // Raw center + radius the cell was searched at (for display/debug).
  centerLat:  { type: Number, required: true },
  centerLng:  { type: Number, required: true },
  radiusM:    { type: Number, required: true },

  // Cached payload: the full result list from placeSearch's normalizer.
  // Stored as a plain array of subdocs so we can run countWithin against
  // any sub-radius without going back to Google.
  results:    { type: Array, default: [] },

  // Pre-computed counts.
  count:             { type: Number, default: 0 }, // length of results
  countWithinRadius: { type: Number, default: 0 }, // count within `radiusM`

  fetchedAt:  { type: Date, default: Date.now },
  // Mongo TTL — `expires: 0` means delete when Date.now() >= expiresAt.
  expiresAt:  { type: Date, default: () => new Date(Date.now() + SEVEN_DAYS_MS),
                index: { expires: 0 } },
});

DispensaryDensityCacheSchema.statics.SEVEN_DAYS_MS = SEVEN_DAYS_MS;

module.exports = mongoose.model('DispensaryDensityCache', DispensaryDensityCacheSchema);
