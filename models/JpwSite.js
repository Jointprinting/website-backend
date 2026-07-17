const mongoose = require('mongoose');

// JP Webworks client site — the record behind the Studio's Websites builder.
// One doc per client site: which template renders it, the content the owner
// typed in (the `data` blob the templates consume), and where it is in the
// business lifecycle:
//
//   draft   → being built; NOT publicly reachable (the public endpoint 404s)
//   preview → published to the free preview URL (/webworks/p/<slug>) so the
//             prospect can see their site before paying
//   live    → client paid; a real domain is connected (stored in `domain`;
//             the domain itself is attached to the Vercel project by hand)
//
// `data` is a free-form template payload (businessName, tagline, services[],
// hours[], testimonials[], paletteId, …) — deliberately schemaless so template
// fields can evolve without migrations; the controller caps its JSON size.

// A client change request against a live/preview site — the "edits queue" the
// ops tool works through ("move the hours up", "swap the hero photo"). This is
// the ongoing-care work a Webworks subscription pays for, tracked per site.
const EDIT_STATUSES = ['open', 'in_progress', 'done'];
const JpwSiteEditSchema = new mongoose.Schema({
  body:      { type: String, required: true, trim: true, maxlength: 2000 },
  status:    { type: String, enum: EDIT_STATUSES, default: 'open' },
  source:    { type: String, default: 'owner' }, // owner | client | ops
  createdAt: { type: Date, default: Date.now },
  doneAt:    { type: Date, default: null },
}); // keeps its own _id so a single edit can be updated by id

const JpwSiteSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true, maxlength: 120 }, // client/business label in the Studio
  slug:         { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 80 },
  businessType: { type: String, trim: true, maxlength: 60, default: '' },
  templateId:   { type: String, required: true, trim: true, maxlength: 40 },
  status:       { type: String, enum: ['draft', 'preview', 'live'], default: 'draft', index: true },
  domain:       { type: String, trim: true, lowercase: true, maxlength: 200, default: '' },
  data:         { type: Object, default: {} },

  // ── Ecosystem spine (previously missing — a site floated free of the CRM) ──
  // The same key Client/Order/Deal/Subscription use, so a built site joins its
  // company card and its care-plan subscription. Optional (a legacy site may have
  // none until the owner links it); indexed for the company-detail join.
  companyKey:   { type: String, default: '', index: true },
  // The inbound webworks inquiry this site was built from, when it came from one.
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactSubmission', default: null },

  // ── Ongoing ops ──
  edits:        { type: [JpwSiteEditSchema], default: [] },
  // Lightweight up/down health of the LIVE client site (owner-run or scheduled
  // check). 'unknown' until first checked; only meaningful for a live+domain site.
  health: {
    status:        { type: String, enum: ['unknown', 'ok', 'down'], default: 'unknown' },
    lastCheckedAt: { type: Date, default: null },
    httpStatus:    { type: Number, default: null },
    note:          { type: String, default: '' },
  },

  // ── Soft-delete (house rule: nothing is hard-deleted) ──
  archived:     { type: Boolean, default: false, index: true },
  archivedAt:   { type: Date, default: null },
}, { timestamps: true, minimize: false }); // minimize:false keeps `data: {}` from vanishing

JpwSiteSchema.statics.EDIT_STATUSES = EDIT_STATUSES;

module.exports = mongoose.model('JpwSite', JpwSiteSchema);
module.exports.EDIT_STATUSES = EDIT_STATUSES;
