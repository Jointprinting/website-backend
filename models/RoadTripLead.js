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
  'planned',          // saved, not yet visited
  'pre_called',       // called ahead before showing up
  'visited',          // stopped by
  'buyer_identified', // found buyer/manager name
  'pitched',          // gave the pitch in person
  'catalog_sent',     // sent catalog/follow-up
  'mockup_needed',    // they want to see designs
  'quote_needed',     // need to price something
  'follow_up',        // warm lead, nurturing
  'won',              // closed / got an order
  'dead',             // not interested
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

  // Sales pipeline fields
  score:          { type: String, enum: ['A', 'B', 'C', ''], default: '' }, // A=high value, B=ok, C=low priority
  contactEmail:   { type: String, default: '' },
  followUpDate:   { type: Date },
  visitOutcome:   { type: String, default: '' }, // brief outcome from visit
  itemInterests:  { type: [String], default: [] }, // e.g. ['T-shirts', 'Lighters', 'Hats']
  existingVendor: { type: Boolean, default: false }, // already has a merch vendor
  referredBy:     { type: String, default: '' }, // who sent you there
  customType:     { type: String, default: '' }, // for 'other' pins: 'friend' | 'client' | 'printer' | ''

  // Trip planning — items are grouped by day inside the itinerary panel.
  // `dayLabel` is a free-text day name (default "Day 1"). Items with no
  // dayLabel show under "Unassigned" until the user moves them.
  // `sortOrder` controls position within the day.
  tripLabel: { type: String, default: '' },
  dayLabel:  { type: String, default: '' },
  sortOrder: { type: Number, default: 0 },

  // Sleep slot for this lead on its day. At most one 'primary' and one
  // 'backup' per (tripLabel, dayLabel) — soft-enforced in the controller by
  // demoting prior holders before assigning. `type` (above) drives the map
  // layer/heatmap; `sleepKind` only drives the TONIGHT chip styling
  // (campground vs Park & Ride etc.) so the dispensary search and heatmap
  // stay clean.
  sleepRole:     { type: String, enum: ['', 'primary', 'backup'], default: '' },
  sleepKind:     { type: String, enum: ['', 'campground', 'park_and_ride', 'hotel', 'friend', 'other'], default: '' },
  isActiveSleep: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

RoadTripLeadSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

RoadTripLeadSchema.statics.TYPES    = LEAD_TYPES;
RoadTripLeadSchema.statics.KINDS    = LEAD_KINDS;
RoadTripLeadSchema.statics.STATUSES = LEAD_STATUSES;

const RoadTripLead = mongoose.model('RoadTripLead', RoadTripLeadSchema);
RoadTripLead.LEAD_STATUSES = LEAD_STATUSES;

module.exports = RoadTripLead;
