// models/JpwLead.js
//
// JP Webworks lead recon — local service businesses we want to call. Stores
// everything needed to make the call-or-skip decision in one place:
//
//   - Identity & contact info (with normalized dedupe keys)
//   - Google/GBP signals (rating, review_count, place_id, maps_url)
//   - Website audit results (filled by the auditor service in Phase 2)
//   - Ad activity signals (Meta Ad Library, manual or scraped, in Phase 3+)
//   - Lead score (computed by services/jpwScoring whenever the lead changes)
//   - Call queue state (status + notes + last_contacted)
//   - Spider push state (was this lead pushed to the Google Sheet, when)
//
// One collection, denormalized — these documents are read together as a unit
// in the UI, no relations needed.

const mongoose = require('mongoose');

const WebsiteAuditSchema = new mongoose.Schema({
  audited_url:                String,
  final_url:                  String,
  status_code:                Number,
  loads_successfully:         Boolean,
  ssl_valid:                  Boolean,
  fetch_duration_ms:          Number,
  html_bytes:                 Number,
  pages_audited:              Number,
  contact_page_url:           String,
  services_page_url:          String,
  has_mobile_viewport:        Boolean,
  viewport_content:           String,
  viewport_valid:             Boolean,
  has_title:                  Boolean,
  title:                      String,
  has_meta_description:       Boolean,
  meta_description:           String,
  has_h1:                     Boolean,
  h1:                         String,
  has_og_tags:                Boolean,
  has_twitter_card:           Boolean,
  has_favicon:                Boolean,
  has_robots_txt:             Boolean,
  has_sitemap:                Boolean,
  sitemap_url_count:          Number,
  has_visible_phone:          Boolean,
  has_click_to_call:          Boolean,
  phones_found:               { type: [String], default: undefined },
  lead_phone_matches_site:    Boolean,
  has_contact_form:           Boolean,
  form_count:                 Number,
  forms_post_https:           Boolean,
  has_quote_cta:              Boolean,
  has_cta_above_fold:         Boolean,
  has_services_list:          Boolean,
  has_service_area_terms:     Boolean,
  service_area_count:         Number,
  has_reviews_on_site:        Boolean,
  has_gallery:                Boolean,
  has_google_map_embed:       Boolean,
  has_schema:                 Boolean,
  has_localbusiness_schema:   Boolean,
  localbusiness_schema_valid: Boolean,
  schema_name:                String,
  schema_telephone:           String,
  schema_address:             String,
  outdated_copyright:         Boolean,
  copyright_year:             Number,
  broken_link_count:          Number,
  mixed_content_count:        Number,
  cms_detected:               String,
  tech_stack:                 { type: [String], default: undefined },
  wp_version:                 String,
  is_default_template:        String,
  chat_widget:                String,
  appointment_tool:           String,
  has_live_chat:              Boolean,
  has_online_booking:         Boolean,
  social_links:               { type: [String], default: undefined },
  has_tracking_pixels:        Boolean,
  has_landing_page_structure: Boolean,
  mobile_speed_score:         Number,
  desktop_speed_score:        Number,
  audited_at:                 Date,
  notes:                      String,
}, { _id: false });

const AdSignalSchema = new mongoose.Schema({
  source:             { type: String, default: 'manual' }, // 'manual' | 'meta_library' | 'apify'
  active_ads_found:   { type: mongoose.Schema.Types.Mixed }, // true | false | 'possible'
  active_ad_count:    Number,
  confidence:         { type: String, default: '' }, // 'confirmed' | 'possible' | 'low'
  page_name:          String,
  page_url:           String,
  page_id:            String,
  ad_snapshot_urls:   { type: [String], default: [] },
  ad_text_samples:    { type: [String], default: [] },
  landing_page_urls:  { type: [String], default: [] },
  ad_angle_summary:   String,
  first_seen_date:    Date,
  latest_seen_date:   Date,
  matched_keywords:   { type: [String], default: [] },
  manual_notes:       String,
}, { _id: false });

// Sub-shape for one bucket of the 100-pt score. `reasons` is the list of
// human-readable strings the scoring engine produced for that bucket — they
// power the inline "why" the UI shows under each progress bar.
const ScoreBucketSchema = new mongoose.Schema({
  value:   { type: Number, default: 0 },
  reasons: { type: [String], default: [] },
}, { _id: false });

const LeadScoreSchema = new mongoose.Schema({
  score:             { type: Number, default: 0 },
  grade:             { type: String, default: 'D' },
  breakdown: {
    buyingIntent:    { type: ScoreBucketSchema, default: () => ({}) },
    pain:            { type: ScoreBucketSchema, default: () => ({}) },
    abilityToPay:    { type: ScoreBucketSchema, default: () => ({}) },
    fit:             { type: ScoreBucketSchema, default: () => ({}) },
    urgency:         { type: ScoreBucketSchema, default: () => ({}) },
    rawTotal:        { type: Number, default: 0 },
    penaltyDelta:    { type: Number, default: 0 },
  },
  recommendedOffer:  String,
  pitchAngle:        String,
  opener:            String,
  reasonSummary:     String,
  mainPainPoints:    { type: [String], default: [] },
  buyingSignals:     { type: [String], default: [] },
  disqualifiers:     { type: [String], default: [] },
  penalties:         { type: [String], default: [] },
  scoredAt:          Date,
}, { _id: false });

const CALL_STATUSES = [
  'new', 'call_today', 'called_no_answer', 'left_voicemail', 'gatekeeper',
  'interested', 'audit_requested', 'booked', 'not_fit', 'do_not_call', 'follow_up',
];

const JpwLeadSchema = new mongoose.Schema({
  // ── Identity ────────────────────────────────────────────────────────────
  business_name:    { type: String, required: true },
  normalized_name:  { type: String, index: true, default: '' },
  phone:            { type: String, default: '' },
  normalized_phone: { type: String, index: true, default: '' },
  website_url:      { type: String, default: '' },
  domain:           { type: String, index: true, default: '' },
  google_place_id:  { type: String, index: true, default: '' },
  google_maps_url:  { type: String, default: '' },
  email:            { type: String, default: '' },

  // ── Location ────────────────────────────────────────────────────────────
  address:          { type: String, default: '' },
  city:             { type: String, default: '' },
  normalized_city:  { type: String, default: '' },
  county:           { type: String, default: '' },
  state:            { type: String, default: 'NJ' },
  postal_code:      { type: String, default: '' },
  lat:              Number,
  lng:              Number,
  address_residential_only: { type: Boolean, default: false },

  // ── Taxonomy ────────────────────────────────────────────────────────────
  category:         { type: String, default: '' },
  subcategory:      { type: String, default: '' },
  is_franchise:     { type: Boolean, default: false },

  // ── Google signals ──────────────────────────────────────────────────────
  rating:           { type: Number, default: 0 },
  review_count:     { type: Number, default: 0 },
  business_status:  { type: String, default: 'OPERATIONAL' },

  // ── Source & provenance ────────────────────────────────────────────────
  source:           { type: String, default: 'manual' }, // 'google_places' | 'apify' | 'outscraper' | 'csv' | 'manual'
  source_query:     { type: String, default: '' },
  source_city:      { type: String, default: '' },
  source_county:    { type: String, default: '' },
  first_seen_at:    { type: Date, default: Date.now },
  last_seen_at:     { type: Date, default: Date.now },

  // ── Sub-documents ──────────────────────────────────────────────────────
  website_audit: { type: WebsiteAuditSchema, default: () => ({}) },
  ad_signal:     { type: AdSignalSchema,     default: () => ({}) },
  lead_score:    { type: LeadScoreSchema,    default: () => ({}) },

  // ── Call queue ─────────────────────────────────────────────────────────
  call_status:        { type: String, enum: CALL_STATUSES, default: 'new' },
  owner_name:         { type: String, default: '' },
  last_contacted_at:  Date,
  next_follow_up_at:  Date,
  call_notes:         { type: String, default: '' },

  // ── Spider push state ──────────────────────────────────────────────────
  pushed_to_spider_at:  Date,
  pushed_to_spider_key: { type: String, default: '' }, // dedupe key actually sent

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

JpwLeadSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Helpful compound index for the most common queries — grade desc, status,
// last-seen recency. The single-field indexes above cover the dedupe paths.
JpwLeadSchema.index({ 'lead_score.score': -1, call_status: 1 });
JpwLeadSchema.index({ 'lead_score.grade': 1, call_status: 1, updatedAt: -1 });

JpwLeadSchema.statics.CALL_STATUSES = CALL_STATUSES;

module.exports = mongoose.model('JpwLead', JpwLeadSchema);
