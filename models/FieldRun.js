// models/FieldRun.js
//
// "Today's Run" — the ordered list of stops the owner is driving right now.
// Replaces the old day-tracker (dayLabel grouping on RoadTripLead): there is
// exactly one ACTIVE run at a time; finishing or clearing it archives it.
// Stops denormalize the fields the run needs (name/address/coords/phone) so
// a run keeps working even if the source dispensary doc changes underneath.

const mongoose = require('mongoose');

const STOP_STATUSES = ['pending', 'visited', 'skipped'];

const RunStopSchema = new mongoose.Schema({
  dispensaryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dispensary', default: null },
  leadId:       { type: mongoose.Schema.Types.ObjectId, ref: 'RoadTripLead', default: null }, // custom pins
  name:    { type: String, required: true },
  address: { type: String, default: '' },
  phone:   { type: String, default: '' },
  lat:     { type: Number, required: true },
  lng:     { type: Number, required: true },
  placeId: { type: String, default: '' },
  chainName: { type: String, default: '' },
  companyKey: { type: String, default: '' },

  order:     { type: Number, default: 0 },
  status:    { type: String, enum: STOP_STATUSES, default: 'pending' },
  visitedAt: { type: Date, default: null },
  outcome:   { type: String, default: '' }, // 'pitched' | 'no_buyer' | 'dead' | '' — free-form safe
});

const FieldRunSchema = new mongoose.Schema({
  label:    { type: String, default: '' },   // display label, defaults to the date
  active:   { type: Boolean, default: true, index: true },
  startLat: { type: Number, default: null }, // where the run was optimized from
  startLng: { type: Number, default: null },
  stops:    { type: [RunStopSchema], default: [] },
  endedAt:  { type: Date, default: null },
}, { timestamps: true });

FieldRunSchema.statics.STOP_STATUSES = STOP_STATUSES;

module.exports = mongoose.model('FieldRun', FieldRunSchema);
