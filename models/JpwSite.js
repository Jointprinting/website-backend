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
const JpwSiteSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true, maxlength: 120 }, // client/business label in the Studio
  slug:         { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 80 },
  businessType: { type: String, trim: true, maxlength: 60, default: '' },
  templateId:   { type: String, required: true, trim: true, maxlength: 40 },
  status:       { type: String, enum: ['draft', 'preview', 'live'], default: 'draft', index: true },
  domain:       { type: String, trim: true, lowercase: true, maxlength: 200, default: '' },
  data:         { type: Object, default: {} },
}, { timestamps: true, minimize: false }); // minimize:false keeps `data: {}` from vanishing

module.exports = mongoose.model('JpwSite', JpwSiteSchema);
