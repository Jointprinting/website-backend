// models/RoadTripLead.js
//
// Leads captured during road-trip recon. Kept intentionally simple — once
// a lead becomes "real" (post-pitch interest), the user moves it into
// their main CRM/Notion manually. This model only holds what's needed for
// field operations: where the place is, what type, what was said, and
// what state the relationship is in.
//
// Nothing in this app ever auto-deletes leads. Removal requires an explicit
// DELETE call from the admin UI.

const mongoose = require('mongoose');

const LEAD_TYPES = ['dispensary', 'coffee', 'park_national', 'park_state', 'campground', 'other'];
const LEAD_KINDS = ['lead', 'stop'];   // 'lead' = sales prospect, 'stop' = trip waypoint
const LEAD_STATUSES = [
  'planned',     // saved but not yet visited
  'visited',     // stopped by, didn't pitch
  'pitched',     // pitched merch, awaiting reply
  'lead',        // real interest, follow up
  'customer',    // converted
  'dead',        // not interested / closed
];

const RoadTripLeadSchema = new mongoose.Schema({
  // Where the lead originated. 'manual' if the admin typed it in directly.
  source:     { type: String, default: 'manual' }, // 'google_places' | 'nps' | 'ridb' | 'osm' | 'manual'
  externalId: { type: String, default: '' },        // Google place_id, NPS parkCode, RIDB facilityId

  // Display fields
  name:    { type: String, required: true },
  address: { type: String, default: '' },
  phone:   { type: String, default: '' },
  website: { type: String, default: '' },

  // Geography
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },

  // Taxonomy
  type:   { type: String, enum: LEAD_TYPES, default: 'other' },
  // 'lead' = something I might pitch merch to (dispensaries)
  // 'stop' = a waypoint on my route (coffee, parks, camping, etc.)
  kind:   { type: String, enum: LEAD_KINDS, default: 'lead' },
  status: { type: String, enum: LEAD_STATUSES, default: 'planned' },

  // Field notes
  contactName: { type: String, default: '' }, // who you spoke to
  notes:       { type: String, default: '' },
  visitedAt:   { type: Date },                // when you actually showed up

  // Trip planning — items are grouped by day inside the itinerary panel.
  // `dayLabel` is a free-text day name (default "Day 1"). Items with no
  // dayLabel show under "Unassigned" until the user moves them.
  // `sortOrder` controls position within the day.
  tripLabel: { type: String, default: '' },
  dayLabel:  { type: String, default: '' },
  sortOrder: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

RoadTripLeadSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

RoadTripLeadSchema.statics.TYPES = LEAD_TYPES;
RoadTripLeadSchema.statics.KINDS = LEAD_KINDS;
RoadTripLeadSchema.statics.STATUSES = LEAD_STATUSES;

module.exports = mongoose.model('RoadTripLead', RoadTripLeadSchema);
