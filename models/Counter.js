const mongoose = require('mongoose');

// Atomic sequence counters for projectNumber / orderNumber assignment.
// _id is the counter name ('project' | 'invoice'); seq is the last issued
// number. Claimed with $inc so two concurrent creates can never get the
// same number (the old find-all → max+1 pattern raced).
const CounterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
}, { versionKey: false });

module.exports = mongoose.model('Counter', CounterSchema);
