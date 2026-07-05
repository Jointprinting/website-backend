// models/OsmScanTile.js
//
// A ledger of map areas already swept for dispensaries via the free
// OpenStreetMap (Overpass) viewport scan. The Field Map fires a scan as the
// owner pans; this record throttles it so each ~0.5° tile hits Overpass at most
// once per TTL window (see controllers/dispensary.scanOsm) — panning around a
// worked area is served from our own DB, not re-queried. Absence of pins alone
// can't tell "scanned, none here" from "never scanned", so the sweep needs its
// own ledger.

const mongoose = require('mongoose');

const OsmScanTileSchema = new mongoose.Schema({
  // "<latTile>_<lngTile>" at the tile grid resolution — the tile CONTAINING the
  // viewport center when it was scanned.
  tileKey:   { type: String, required: true, unique: true },
  scannedAt: { type: Date, default: Date.now, index: true },
  found:     { type: Number, default: 0 },  // candidates Overpass returned last scan
  imported:  { type: Number, default: 0 },  // new Dispensary rows inserted last scan
}, { timestamps: true });

module.exports = mongoose.model('OsmScanTile', OsmScanTileSchema);
