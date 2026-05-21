const mongoose = require('mongoose');

function deriveCompanyKey(companyName, clientName) {
  const raw = (companyName || clientName || '').toString();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const OrderSchema = new mongoose.Schema({
  orderNumber:   { type: String, index: true },
  clientName:    { type: String, default: '', index: true },
  companyName:   { type: String, default: '', index: true },
  companyKey:    { type: String, default: '', index: true },
  status: {
    type: String,
    enum: ['quoted', 'approved', 'placed', 'in_production', 'shipped', 'delivered', 'cancelled'],
    default: 'quoted',
  },
  totalValue:    { type: Number, default: 0 },
  cogs:          { type: Number, default: 0 },
  printerName:   { type: String, default: '' },
  notes:         { type: String, default: '' },
  mockupNumbers: [{ type: String }],
  projectId:           { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  contactSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactSubmission', default: null },
  items: [{
    description: { type: String, default: '' },
    qty:         { type: Number, default: 0 },
    unitPrice:   { type: Number, default: 0 },
    _id: false,
  }],
  orderDate:     { type: Date },
  shipDate:      { type: Date },
  deliveredDate: { type: Date },
  importedFrom:  { type: String, default: '' },
  files: [{
    filename:     { type: String },
    originalName: { type: String },
    mimetype:     { type: String },
    size:         { type: Number },
    uploadedAt:   { type: Date, default: Date.now },
    _id: false,
  }],
}, { timestamps: true });

OrderSchema.pre('save', function (next) {
  this.companyKey = deriveCompanyKey(this.companyName, this.clientName);
  next();
});

OrderSchema.pre('findOneAndUpdate', function (next) {
  const u = this.getUpdate() || {};
  const set = u.$set || u;
  if (set.companyName !== undefined || set.clientName !== undefined) {
    set.companyKey = deriveCompanyKey(set.companyName, set.clientName);
    if (u.$set) u.$set = set; else Object.assign(u, set);
    this.setUpdate(u);
  }
  next();
});

module.exports = mongoose.model('Order', OrderSchema);
module.exports.deriveCompanyKey = deriveCompanyKey;
