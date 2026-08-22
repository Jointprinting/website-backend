// models/PreorderLink.js
//
// A PREORDER LINK — an expiring public page (/preorder/<token>) where a
// client's people commit to quantities BEFORE the run is placed: names and
// counts, never payments. The owner mints one per drop (usually against a
// project), sends a single URL, and watches the tally roll up in the Studio.
// Revoke clears nothing — it just closes the door (house rule: no deletes).

const mongoose = require('mongoose');

const commitmentSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  contact:   { type: String, default: '', trim: true },   // phone or email, their choice
  itemId:    { type: String, required: true },
  variant:   { type: String, default: '' },   // brand the customer chose (label snapshot)
  color:     { type: String, default: '' },   // garment color the customer chose
  size:      { type: String, default: '' },
  qty:       { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, default: 0 },     // price snapshot at commit — the record of what they'll owe
  note:      { type: String, default: '', trim: true },
  at:        { type: Date, default: Date.now },
  // IDEMPOTENCY. The commit page is public and unauthenticated, and people
  // submit it from phones on bad signal. The browser generates one id per
  // filled-out form and resends it on every retry, so a double-tap or a
  // retried request lands ONCE. Without it a second tap silently doubles the
  // garments — and the roll-in orders that many blanks for real.
  submissionId: { type: String, default: '' },
}, { _id: true });

// A brand option inside an item — the choice the customer actually makes, with
// its own customer price (the client's tier + markup collapsed to one per-unit
// number) and its garment colors.
//
// This has to be DECLARED. `_cleanItems` has always built these, the public page
// has always rendered them, and `commitPreorder` prices off them — but the item
// sub-schema listed only id/label/sizes, so Mongoose strict dropped the whole
// array on every save. Every priced drop lost its brands and prices the moment it
// was minted, every commitment booked unitPrice 0, and the per-brand breakdown
// (the number you need to actually place the order) was permanently empty.
const variantSchema = new mongoose.Schema({
  id:     { type: String, required: true },
  name:   { type: String, required: true, trim: true },
  price:  { type: Number, default: 0, min: 0 },   // per-unit customer price
  colors: { type: [String], default: [] },
}, { _id: false });

const preorderLinkSchema = new mongoose.Schema({
  // Two doors per drop. `token` is the CUSTOMER commit page (fun, FOMO-gated).
  // `clientToken` is the CLIENT/organizer view (professional: full progress even
  // before MOQ + the customer link to share) — a separate secret so a customer
  // can't append their way into the pre-MOQ numbers the FOMO rule hides.
  token:       { type: String, required: true, unique: true, index: true },
  clientToken: { type: String, default: '', index: true },
  // Ecosystem links — same identifiers the rest of the Studio rides on.
  companyKey:    { type: String, default: '', index: true },
  projectNumber: { type: String, default: '' },
  orderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  title: { type: String, required: true, trim: true },
  note:  { type: String, default: '', trim: true },
  // Where committers pick up (store name + address). Shown on commit + on both
  // links so everyone knows where it lands — no shipping addresses collected.
  pickupLocation: { type: String, default: '', trim: true },
  // What people commit to. Sizes optional (promo items have none).
  items: [{
    id:    { type: String, required: true },
    label: { type: String, required: true, trim: true },
    sizes: { type: [String], default: [] },
    // Empty = a legacy item (label + sizes, no priced choice). Every drop minted
    // before this field existed reads exactly that way, so nothing changes for them.
    variants: { type: [variantSchema], default: [] },
  }],
  // Minimum order quantity for the whole drop to be "a go". 0 = no minimum (an
  // open tally). Drives the group-buy psychology: the public FOMO progress bar
  // only reveals ONCE the drop has passed its MOQ (owner's rule — an empty bar
  // reads as unpopular; a full one is social proof). The owner always sees it.
  moq:       { type: Number, default: 0, min: 0 },
  expiresAt: { type: Date, default: null },   // null = open until revoked
  revokedAt: { type: Date, default: null },
  commitments: { type: [commitmentSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

// A link is open for commitments only while un-revoked and un-expired.
preorderLinkSchema.methods.isOpen = function isOpen() {
  if (this.revokedAt) return false;
  if (this.expiresAt && new Date(this.expiresAt).getTime() < Date.now()) return false;
  return true;
};

module.exports = mongoose.model('PreorderLink', preorderLinkSchema);
