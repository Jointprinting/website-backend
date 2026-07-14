// models/Printer.js
//
// The PRINTER NETWORK — contract printers the owner routes jobs through
// (Heritage in PA first; more as the network grows). Each doc carries the
// printer's home state (the nexus fact the quoter's ship-to check rides on:
// the printer's state and the job's ship-to state must differ), what they can
// print, and their full scraped price catalog (Mixed — each printer's PDF has
// its own shape; the quoter reads sections it understands and ignores the rest).

const mongoose = require('mongoose');

const printerSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },  // slug, e.g. 'heritage'
  name:  { type: String, required: true },
  state: { type: String, default: '' },                   // USPS code, e.g. 'PA'
  location: { type: String, default: '' },                // "Warminster, PA"
  contact:  { type: mongoose.Schema.Types.Mixed, default: null },
  capabilities: { type: [String], default: [] },          // 'screen_printing' | 'embroidery' | 'dtg' | ...
  // The scraped price catalog (data/printerCatalog-<key>.json). Shape varies
  // per printer; treat as reference data, never write from the app.
  catalog: { type: mongoose.Schema.Types.Mixed, default: null },
  catalogEffective: { type: String, default: '' },        // e.g. '2025-01-01'
  notes:  { type: String, default: '' },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Printer', printerSchema);
