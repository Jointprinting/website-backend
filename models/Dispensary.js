// models/Dispensary.js
//
// The nationwide dispensary database behind the Field Map. One doc per
// retail location. Rows arrive from three places, in trust order:
//
//   source 'roster' — a state regulator license roll (verified: the place is
//                     LICENSED for adult-use retail; smoke shops can't appear)
//   source 'google' — the live Places sweep found it but no roster row matched
//                     (verified:false → renders as an "unverified" pin)
//   source 'manual' — the admin added it by hand
//
// Enrichment (services/dispensaryEnrich.js) fills the Google-side fields
// (placeId, phone, website, rating, businessStatus) on top of whichever
// source created the row. Identity: state+licenseNumber when the roster gave
// us one, else placeId, else name+address — dedupeKey captures that.
//
// companyKey/matchKey mirror the CRM's derivation so pins can cross-reference
// Clients ("this store is already a customer") with one indexed lookup.

const mongoose = require('mongoose');

const DispensarySchema = new mongoose.Schema({
  state:      { type: String, required: true, index: true },  // 'NJ'
  name:       { type: String, required: true },               // DBA / storefront name
  licensee:   { type: String, default: '' },                  // legal entity on the license
  licenseNumber: { type: String, default: '' },
  licenseType:   { type: String, default: '' },               // raw roster type string
  licenseStatus: { type: String, default: '' },               // raw roster status string

  address: { type: String, default: '' },
  city:    { type: String, default: '' },
  zip:     { type: String, default: '' },
  lat:     { type: Number, default: null },
  lng:     { type: Number, default: null },

  // Google enrichment
  placeId:        { type: String, default: '', index: true },
  phone:          { type: String, default: '' },
  website:        { type: String, default: '' },
  rating:         { type: Number, default: null },
  ratingCount:    { type: Number, default: null },
  businessStatus: { type: String, default: '' },  // OPERATIONAL | CLOSED_PERMANENTLY | ...
  googleMapsUri:  { type: String, default: '' },
  enrichedAt:     { type: Date, default: null },

  // Chain detection (services/dispensaryChains.js)
  isChain:   { type: Boolean, default: false },
  chainName: { type: String, default: '' },

  // Market segment for the Field Map's clickers: 'rec' | 'med' | 'hemp'
  // ('' = unknown, never filtered out). Stamped at ingest/scan time via
  // services/dispensaryStates.deriveSegment; legacy rows without a stamp are
  // derived at read time from the same rule, so a state list update
  // reclassifies old pins automatically.
  segment:    { type: String, enum: ['rec', 'med', 'hemp', ''], default: '', index: true },

  // Provenance / lifecycle
  //   'osm' — discovered free via OpenStreetMap (Overpass) as the map is panned;
  //           community-mapped, so verified:false (not a license-roster row).
  source:     { type: String, enum: ['roster', 'google', 'manual', 'osm'], default: 'roster' },
  verified:   { type: Boolean, default: true },   // true = backed by a license roster row
  active:     { type: Boolean, default: true },   // false = closed / license inactive
  hidden:     { type: Boolean, default: false },  // admin "not a dispensary" — never shown
  dedupeKey:  { type: String, required: true, unique: true },
  rosterSource:   { type: String, default: '' },  // URL/dataset the row came from
  lastVerifiedAt: { type: Date, default: null },  // last time a roster pass saw it

  // CRM cross-reference (same derivations as models/Order.js deriveCompanyKey
  // and utils/fieldTrackerImport.js matchKey)
  companyKey: { type: String, default: '', index: true },
  matchKey:   { type: String, default: '', index: true },

  // Field history
  lastVisitedAt: { type: Date, default: null },
}, { timestamps: true });

DispensarySchema.index({ lat: 1, lng: 1 });
DispensarySchema.index({ state: 1, chainName: 1 });

module.exports = mongoose.model('Dispensary', DispensarySchema);
