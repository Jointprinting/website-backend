// controllers/purchaseOrders.js
//
// Purchase orders for printers/vendors — built per project, downloaded as a
// PDF the admin emails out himself. Mirrors the hand-made Google Docs POs:
// "{Vendor} x Joint Printing PO", header fields, shipping block, lettered
// product/print items, order summary charges, grand total. Vendors are
// remembered in a small contact book so the next PO pre-fills.

const path = require('path');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const PurchaseOrder = require('../models/PurchaseOrder');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const { nextNumber, bumpCounterTo, peekNumber } = require('../utils/sequence');
const { normalizeOrderNumber } = require('./finances');
const {
  vendorKey, lineKey, chosenQuoteLines, costLineFromQuoteLine, costLineFromConfItem, buildPoLines,
} = require('../utils/poCost');
const {
  vendorMatchKey, isRealVendorName, groupVendorDuplicates,
  pickVendorSurvivor, foldVendorFields, resolveVendorFromList,
} = require('../utils/vendorMatch');

// A blank/unassigned vendor: no real supplier yet, so we never auto-number it.
const isUnassignedVendor = (name) => !vendorKey(name) || vendorKey(name) === vendorKey(UNASSIGNED);

// Exclude soft-deleted (merged-away) vendors from every list/lookup so a merged
// alias never resurfaces in the picker, the resolver, or the dedup grouping.
const NOT_ARCHIVED = { archived: { $ne: true } };

// Resolve a free-text PO vendor name to an EXISTING Vendor record so a typed short
// name ("Heritage") attaches to the real record ("Heritage Screen Printing")
// instead of minting a near-duplicate. Three tiers, most-confident first:
//   1) exact case-insensitive name (what the seeders already used);
//   2) equal fuzzy matchKey (corp/trade suffix stripped) among existing vendors;
//   3) the conservative sameVendor() test (prefix / strong token overlap).
// Tiers 2-3 are AMBIGUITY-SAFE: if more than one distinct existing vendor matches,
// we DON'T guess — we return null (mint/keep the typed name) rather than risk
// attaching to the wrong printer. Returns the matched Vendor doc, or null.
// `candidates` (optional) lets a caller pass an already-fetched vendor list to
// avoid a DB round-trip; otherwise the whole (small) contact book is loaded.
async function _resolveCanonicalVendor(name, candidates = null) {
  const raw = String(name || '').trim();
  if (!isRealVendorName(raw)) return null;
  // Load the (small) contact book once, then run the SHARED pure resolver so the
  // exact → matchKey → conservative-fuzzy decision is identical to what the unit
  // tests pin. Archived (merged-away) records are excluded.
  const all = Array.isArray(candidates) ? candidates : await Vendor.find(NOT_ARCHIVED).lean();
  return resolveVendorFromList(raw, all);
}

// The canonical NAME a typed vendor name should be stored as on a PO. Resolves to
// an existing record's name when one matches; otherwise returns the typed name
// trimmed. Keeps free-text fully allowed (a genuinely new vendor) while folding a
// short alias onto the real record. Returns { name, vendor } (vendor may be null).
async function _canonicalVendorName(typed, candidates = null) {
  const raw = String(typed || '').trim();
  const vendor = await _resolveCanonicalVendor(raw, candidates);
  return { name: vendor ? (vendor.name || raw) : raw, vendor };
}

const JP_LOGO_PATH = path.join(__dirname, '..', 'assets', 'jp-logo.png');
const badId = (id) => !mongoose.isValidObjectId(id);   // 404 instead of a CastError 500
const n = (v) => Number(v) || 0;
const round2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;
const money = (v) => `$${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Pull the per-unit dollar figure out of a charge label so the cost-history
// panel can surface "what we paid per unit last time". Charge labels are built
// by the seeders/builder as "{name}: ${unit}/unit * {qty} units" (see
// buildPoLines), but they're free-text too — vendors and the owner edit them by
// hand — so this stays forgiving on whitespace/commas/plural.
//
// It must read only a REAL unit-cost token, not a stray number that happens to
// sit before "/unit" in prose (M1: "ship to 5/unit" must NOT yield 5). So the
// per-unit figure has to be MONEY-SHAPED: either it carries a "$", or it has a
// decimal cents part. A bare integer with no "$" (the prose case) is rejected.
// Returns the number (commas stripped) or null when there's no per-unit figure.
function parseUnitCost(label) {
  const s = String(label == null ? '' : label);
  // Case 1: explicit "$" — "$12/unit", "$1,000/unit", "$2.40 / unit".
  let m = s.match(/\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*units?\b/i);
  // Case 2: no "$" but a decimal cents figure — "2.40/unit". A leading boundary
  // (start, or a non-word char) keeps it from latching onto "v2.40/unit" garble.
  if (!m) m = s.match(/(?:^|[^\w.])([\d,]+\.\d+)\s*\/\s*units?\b/i);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

// Seed a draft PO from the order: vendor from printerName, shipping from the
// confirmation, items/charges from the CANONICAL chosen quote lines at COST
// (utils/poCost — blank only when the owner doesn't supply it, plus print per
// unit; setup as its own line; freight excluded), never client pricing. Uses the
// exact same cost-basis + line-selection helper as the confirmation seeder so an
// identical job yields an identical vendor PO regardless of entry path.
function _seedFromOrder(order, blanksProvided) {
  const conf = order.confirmation || {};
  const lines = chosenQuoteLines(order.quoteLines).map((l) => costLineFromQuoteLine(l, blanksProvided));
  const { items, charges, grandTotal, zeroCostCount } = buildPoLines(lines);
  return {
    vendorName: order.printerName || order.supplier || '',
    shipping: {
      name:          (conf.shipping && conf.shipping.name) || order.companyName || '',
      attention:     (conf.shipping && conf.shipping.attention) || order.clientName || '',
      streetAddress: (conf.shipping && conf.shipping.streetAddress) || '',
      cityStateZip:  (conf.shipping && conf.shipping.cityStateZip) || '',
    },
    items,
    charges,
    grandTotal,
    zeroCostCount,
  };
}

// ── Build POs from the APPROVED confirmation, split by supplier ───────────────
// The confirmation is what the client actually signed off, so it — not the
// pre-approval quote — is the right source for the real vendor POs. Each
// confirmation item carries its own `printerName` (who's actually making it),
// so an order spanning multiple suppliers (screen-printed tees + promo
// lighters) yields ONE PO per supplier, automatically. Costs use the item's
// internal `unitCost × total qty` (what JP pays the vendor), never client
// pricing — same cost basis as _seedFromOrder.

// Which supplier a confirmation item belongs to. Per-item printer wins; fall
// back to the order's printer/supplier; clearly bucket the rest as Unassigned.
const UNASSIGNED = 'Unassigned';
function _confItemSupplier(it, order) {
  return String(it && it.printerName || '').trim()
    || String(order.printerName || order.supplier || '').trim()
    || UNASSIGNED;
}

// Human label for a ship-to destination, used in the per-location PO callouts.
// Prefer the friendly label, then the recipient name, then the city line; fall
// back to a short form of the key so a half-filled destination still reads.
function _shipToName(st) {
  return String((st && (st.label || st.name || st.cityStateZip)) || '').trim()
    || (st && st.key ? `Location ${st.key}` : 'Location');
}

// Per-location split line for one confirmation item, e.g.
// "Ship split — Brooklyn HQ: 20, Newark Store: 15". Returns '' unless the
// order actually has destinations AND this item carries allocations to them —
// so single-location items (no allocations) produce nothing and the PO output
// stays byte-identical to today.
function _itemShipSplit(it, shipTos) {
  if (!Array.isArray(shipTos) || shipTos.length === 0) return '';
  const byKey = new Map(shipTos.map(st => [String(st && st.key || ''), st]));
  const parts = (Array.isArray(it && it.allocations) ? it.allocations : [])
    .filter(a => a && n(a.qty) > 0 && byKey.has(String(a.key)))
    .map(a => `${_shipToName(byKey.get(String(a.key)))}: ${n(a.qty)}`);
  return parts.length ? `Ship split — ${parts.join(', ')}` : '';
}

// True when an item is split across locations but the per-location allocations
// do NOT sum to the item's total size quantity (M4). A split PO built from a
// mismatched allocation would ship the wrong per-location counts, so we surface
// it as a warning before generating. Only flags items that actually carry
// allocations to real destinations — an unsplit item (no allocations) is fine.
function _allocMismatch(it, shipTos) {
  if (!Array.isArray(shipTos) || shipTos.length === 0) return false;
  const keys = new Set(shipTos.map(st => String(st && st.key || '')));
  const allocs = (Array.isArray(it && it.allocations) ? it.allocations : [])
    .filter(a => a && keys.has(String(a.key)));
  if (allocs.length === 0) return false;   // not split — nothing to reconcile
  const allocated = allocs.reduce((s, a) => s + n(a.qty), 0);
  const totalQty = (Array.isArray(it && it.sizes) ? it.sizes : []).reduce((s, sz) => s + n(sz.qty), 0);
  return allocated !== totalQty;
}

// Build one PO draft (existing PO shape) for a single supplier's items. Costs
// run through the SAME utils/poCost helper as the manual seeder: each confirmation
// item is matched back to its quote line to recover the granular blank/print/setup
// cost (so blanksProvided is honored and freight is excluded), falling back to the
// item's own unitCost when there's no match. `quoteLineByKey` maps a style|color|
// print key → quote line (built once per order by the caller).
function _seedPoForGroup(order, vendorName, groupItems, blanksProvided, quoteLineByKey) {
  const conf = order.confirmation || {};
  const shipTos = Array.isArray(conf.shipTos) ? conf.shipTos : [];
  const lines = (groupItems || []).map((it) => {
    const cl = costLineFromConfItem(it, blanksProvided, quoteLineByKey);
    cl._item = it;   // keep the source item so detailFor can read its size run + allocations
    return cl;
  });
  const { items, charges, grandTotal, zeroCostCount } = buildPoLines(lines, {
    detailFor: (cl) => {
      const it = cl._item || {};
      const sizes = Array.isArray(it.sizes) ? it.sizes : [];
      const out = [];
      // Size run, e.g. "S: 10 · M: 25 · L: 15" — what the vendor actually makes.
      const run = sizes.filter((sz) => n(sz.qty) > 0).map((sz) => `${sz.label || '—'}: ${n(sz.qty)}`).join(' · ');
      if (run) out.push(run);
      // Per-location breakdown — only when this order ships to multiple
      // destinations and this item is split across them (additive).
      const split = _itemShipSplit(it, shipTos);
      if (split) out.push(split);
      return out;
    },
  });
  const seeded = {
    vendorName,
    shipping: {
      name:          (conf.shipping && conf.shipping.name) || order.companyName || '',
      attention:     (conf.shipping && conf.shipping.attention) || order.clientName || '',
      streetAddress: (conf.shipping && conf.shipping.streetAddress) || '',
      cityStateZip:  (conf.shipping && conf.shipping.cityStateZip) || '',
    },
    items,
    charges,
    grandTotal,
    zeroCostCount,
    // Count of items whose per-location split doesn't reconcile to the item qty
    // (M4) — surfaced as a warning by the caller, never blocks generation.
    allocMismatchCount: (groupItems || []).reduce((c, it) => c + (_allocMismatch(it, shipTos) ? 1 : 0), 0),
  };
  // When the order ships to multiple destinations, lead the PO notes with a
  // concise roster of where things go so the vendor sees it at a glance. Only
  // added when shipTos is non-empty — single-location POs keep blank notes.
  const note = _shipNotes(shipTos);
  if (note) seeded.notes = note;
  return seeded;
}

// Concise multi-location roster for the PO Notes section. One line per
// destination with its address. '' when there are no destinations, so the PO's
// notes stay empty for single-location orders (output unchanged).
function _shipNotes(shipTos) {
  if (!Array.isArray(shipTos) || shipTos.length === 0) return '';
  const rows = shipTos
    .map((st) => {
      const where = [st && st.street, st && st.cityStateZip].map(s => String(s || '').trim()).filter(Boolean).join(', ');
      const label = _shipToName(st);
      return where ? `• ${label} — ${where}` : `• ${label}`;
    });
  return `Shipping to ${shipTos.length} locations:\n${rows.join('\n')}`;
}

// Group confirmation items by supplier, preserving first-seen order so the
// generated POs come out in a stable, sensible sequence. Grouped on the SAME
// normalized vendorKey (trim + collapse whitespace + lowercase) used for
// numbering and the skip check (H1/H3) so a vendor-name typo / stray whitespace
// can't fork a supplier into two POs or split it from its own number sequence.
function _groupConfBySupplier(order) {
  const confItems = (order.confirmation && Array.isArray(order.confirmation.items)) ? order.confirmation.items : [];
  const groups = new Map();   // vendorKey -> { vendorName, items: [] }
  confItems.forEach((it) => {
    const vendorName = _confItemSupplier(it, order);
    const key = vendorKey(vendorName);
    if (!groups.has(key)) groups.set(key, { vendorName, items: [] });
    groups.get(key).items.push(it);
  });
  return [...groups.values()];
}

// Map a style|color|print key → the order's chosen quote line, so the
// confirmation seeder can recover each item's granular blank/print/setup cost
// (and honor blanksProvided) instead of trusting the coarse bundled unitCost.
function _quoteLineIndex(order) {
  const map = new Map();
  chosenQuoteLines(order.quoteLines).forEach((l) => {
    const k = lineKey(l);
    if (!map.has(k)) map.set(k, l);   // first match wins; distinct print variants keep distinct keys
  });
  return map;
}

// POST /api/orders/:id/pos/from-confirmation — one PO per supplier from the
// approved confirmation. Skips suppliers that ALREADY have a PO on this order
// (matched case-insensitively by vendor name), so re-running is safe and never
// silently duplicates; the response says exactly what was created vs skipped.
const createPosFromConfirmation = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: 'Project not found' });

    const groups = _groupConfBySupplier(order);
    if (groups.length === 0) {
      return res.status(400).json({
        message: 'This project has no approved confirmation items to build POs from. Finalize the confirmation first.',
      });
    }

    // Local calendar day from the builder, same handling as createPo.
    const bodyDate = String((req.body && req.body.date) || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(bodyDate) ? new Date(`${bodyDate}T00:00:00Z`) : new Date();
    // Advisory skip (H3): by default we don't re-create a supplier that already
    // has a PO on this order, but the owner can force a regenerate. Either way we
    // NEVER silently drop a supplier's items — the response says what happened.
    const force = !!(req.body && req.body.force);

    // Quote-line lookup so each item recovers its granular cost (blanksProvided +
    // freight handling), shared by every group on this order.
    const quoteLineByKey = _quoteLineIndex(order);

    // Vendors that already have a PO on this order, keyed by the SAME normalized
    // vendorKey used for grouping (H3) — so a whitespace fork can't make a legit
    // second supplier look "already built" and get dropped.
    const existing = await PurchaseOrder.find({ orderId: order._id, ...NOT_ARCHIVED }).select('vendorName').lean();
    const existingKeys = new Set(existing.map(p => vendorKey(p.vendorName)).filter(Boolean));

    const created = [];
    const skipped = [];      // already had a PO; held back (unless force)
    const held = [];         // Unassigned/blank supplier — no number assigned yet (H1)
    const warnings = [];     // zero-cost line warnings (C3)
    for (const g of groups) {
      // H1: never auto-number a blank / "Unassigned" supplier. Hold its items
      // for when a real vendor is set, rather than minting an "Unassigned"
      // sequence that collides with the next unassigned order.
      if (isUnassignedVendor(g.vendorName)) { held.push(g.vendorName || UNASSIGNED); continue; }

      // Canonicalize the supplier name to an existing vendor record (exact →
      // matchKey → conservative fuzzy) so a typed short name attaches to the real
      // printer, then pre-fill its contact card. This is also where
      // vendor.blanksProvided is READ: the contact book remembers each vendor's
      // typical mode. Default true (JP supplies blanks ~99%). The skip + numbering
      // keys are taken from the CANONICAL name so two aliases of one printer
      // ("Heritage" + "Heritage Screen Printing") don't fork into two POs.
      const { name: canonName, vendor } = await _canonicalVendorName(g.vendorName);
      const vendorName = canonName || g.vendorName;
      const key = vendorKey(vendorName);

      // Advisory skip: surface it, but only suppress when not forced (H3).
      if (key && existingKeys.has(key) && !force) { skipped.push(vendorName); continue; }

      const blanksProvided = vendor && vendor.blanksProvided != null ? !!vendor.blanksProvided : true;

      const seeded = _seedPoForGroup(order, vendorName, g.items, blanksProvided, quoteLineByKey);
      if (seeded.zeroCostCount > 0) {
        warnings.push(`${vendorName}: ${seeded.zeroCostCount} line(s) have no cost — fill them in.`);
      }
      if (seeded.allocMismatchCount > 0) {
        warnings.push(`${vendorName}: ${seeded.allocMismatchCount} item(s) have a per-location split that doesn't add up to the item quantity — check the ship-to amounts.`);
      }
      const { zeroCostCount, allocMismatchCount, ...seedFields } = seeded;
      const vendorAddress = vendor ? vendor.address : '';
      const po = await PurchaseOrder.create({
        orderId: order._id,
        // Per-vendor number, floored by the owner-set start (vendor.nextPoStart)
        // so Heritage continues from his real Google-Docs run, not the app's #004.
        poNumber: `#${(await nextNumber('po', vendorName, vendor && vendor.nextPoStart)).padStart(3, '0')}`,
        date,
        vendorName,
        contactName: vendor ? vendor.contactName : '',
        vendorAddress,
        // Default the printer receiving block to the vendor's own address (where
        // JP ships the blanks), editable per PO; finished goods stay in `shipping`.
        shipToPrinter: { name: vendorName, attention: vendor ? vendor.contactName : '', streetAddress: vendorAddress, cityStateZip: '' },
        shipMethod: vendor ? vendor.shipMethod : '',
        blanksProvided,
        ...seedFields,
      });
      created.push(po);
      existingKeys.add(key);   // guard against a duplicate supplier key within one run
    }

    res.status(201).json({
      pos: created,
      summary: {
        created: created.length,
        vendors: created.map(p => p.vendorName),
        skipped,                                   // suppliers that already had a PO on this order (advisory)
        held,                                      // Unassigned/blank suppliers — set a vendor, then re-run
        warnings,                                  // zero-cost line warnings (C3)
        suppliers: groups.length,                  // distinct suppliers found in the confirmation
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/:id/pos
const listPos = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const pos = await PurchaseOrder.find({ orderId: req.params.id, ...NOT_ARCHIVED }).sort({ createdAt: -1 }).lean();
    res.json({ pos });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/:id/pos — body optional { seed: true } pre-fills from the
// order; otherwise creates a mostly-blank PO. Vendor profile (matched by
// printerName) fills contact/address/shipMethod either way.
const createPo = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: 'Project not found' });

    const vendorNameRaw = (req.body && req.body.vendorName) || (order.printerName || order.supplier || '') || '';
    // Canonicalize the typed name to an EXISTING vendor record when one matches
    // (exact → matchKey → conservative fuzzy), so typing "Heritage" attaches to
    // "Heritage Screen Printing" instead of minting a near-duplicate. Falls back
    // to the typed name for a genuinely new vendor.
    let vendor = null;
    let vendorName = vendorNameRaw;
    if (vendorNameRaw) {
      const resolved = await _canonicalVendorName(vendorNameRaw);
      vendor = resolved.vendor;
      vendorName = resolved.name || vendorNameRaw;
    }
    // Honor the vendor's remembered mode (vendor.blanksProvided — previously
    // written but never read). Default true (JP supplies the blanks ~99%).
    const blanksProvided = vendor && vendor.blanksProvided != null ? !!vendor.blanksProvided : true;

    const seeded = req.body && req.body.seed === false ? {} : _seedFromOrder(order, blanksProvided);
    // Prefer the canonicalized vendor name; only fall back to the seed when no
    // name was typed and the order had none.
    if (!vendorName) vendorName = seeded.vendorName || '';
    const { zeroCostCount = 0, ...seedFields } = seeded;

    // The builder sends its local calendar day (YYYY-MM-DD) — the server
    // clock can be a day ahead of the admin's evening, and every render pins
    // to UTC, so seeding from the server instant shows tomorrow's date.
    const bodyDate = String((req.body && req.body.date) || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(bodyDate) ? new Date(`${bodyDate}T00:00:00Z`) : new Date();
    const vendorAddress = vendor ? vendor.address : '';
    const po = await PurchaseOrder.create({
      orderId: order._id,
      // Per-vendor sequence — each printer numbered independently. A brand-new
      // printer seeds from 0 → #001; the owner-set start (vendor.nextPoStart)
      // floors it so an existing printer's old (e.g. Google Docs) run carries
      // forward without colliding. Typing a higher # by hand still bumps too.
      poNumber: `#${(await nextNumber('po', vendorName, vendor && vendor.nextPoStart)).padStart(3, '0')}`,
      date,
      vendorName,
      contactName: vendor ? vendor.contactName : '',
      vendorAddress,
      // Printer receiving block defaults to the vendor address (where the blanks
      // ship); the finished-goods destination stays in `shipping` (seeded above).
      shipToPrinter: { name: vendorName, attention: vendor ? vendor.contactName : '', streetAddress: vendorAddress, cityStateZip: '' },
      shipMethod: vendor ? vendor.shipMethod : '',
      blanksProvided,
      ...seedFields,
    });
    // Surface zero-cost lines (C3) without blocking — the owner may intend a $0
    // sample line, but should be warned rather than shipping a silent $0.
    const warning = zeroCostCount > 0
      ? `${zeroCostCount} line(s) have no cost — fill them in.` : undefined;
    res.status(201).json(warning ? { ...po.toObject(), warning } : po);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// PUT /api/orders/pos/:poId — full update from the builder. Also upserts the
// vendor contact book so the next PO for this vendor pre-fills.
const updatePo = async (req, res) => {
  try {
    if (badId(req.params.poId)) return res.status(404).json({ message: 'PO not found' });
    const body = { ...req.body };
    delete body._id; delete body.orderId; delete body.createdAt; delete body.updatedAt;
    // Keep the grand total honest: recompute from charges when present.
    if (Array.isArray(body.charges)) {
      body.grandTotal = body.charges.reduce((s, c) => s + n(c && c.amount), 0);
    }
    // Canonicalize the vendor name to an existing record when the owner typed a
    // short alias ("Heritage" → "Heritage Screen Printing"), so the save updates
    // the real contact book entry instead of forking a bare duplicate. Only
    // touches the name when a confident match exists; a genuinely new vendor name
    // is preserved verbatim.
    if (typeof body.vendorName === 'string' && body.vendorName.trim()) {
      const { name: canonName } = await _canonicalVendorName(body.vendorName);
      if (canonName) body.vendorName = canonName;
    }
    // Snapshot the number BEFORE the write so we can tell a real hand-edit from a
    // routine save (H2). Auto-saves that don't touch the number must NOT bump any
    // counter — bumping on every save (and against whatever vendor happened to be
    // on the record) is how the wrong vendor's sequence got pushed forward.
    const prev = await PurchaseOrder.findById(req.params.poId).select('poNumber').lean();
    if (!prev) return res.status(404).json({ message: 'PO not found' });

    const po = await PurchaseOrder.findByIdAndUpdate(req.params.poId, { $set: body }, { new: true, runValidators: true }).lean();
    if (!po) return res.status(404).json({ message: 'PO not found' });

    // Only when the owner actually CHANGED the number (e.g. continuing a printer's
    // old Google Docs run) do we push that number's OWN vendor sequence past it,
    // so a future auto-assignment for THAT vendor can't collide (H2).
    const numberChanged = String(po.poNumber || '') !== String(prev.poNumber || '');
    if (numberChanged && po.poNumber) await bumpCounterTo('po', po.poNumber, po.vendorName);

    if (po.vendorName) {
      await Vendor.findOneAndUpdate(
        // Case-insensitive, like the createPo lookup — otherwise "heritage"
        // and "Heritage" become two contact-book entries.
        { name: new RegExp(`^${String(po.vendorName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        { $set: {
          name: po.vendorName,
          contactName: po.contactName || '',
          address: po.vendorAddress || '',
          shipMethod: po.shipMethod || '',
          blanksProvided: !!po.blanksProvided,
        } },
        { upsert: true },
      ).catch(() => { /* contact book is best-effort */ });
    }
    res.json(po);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// DELETE /api/orders/pos/:poId
const deletePo = async (req, res) => {
  try {
    if (badId(req.params.poId)) return res.status(404).json({ message: 'PO not found' });
    await PurchaseOrder.findByIdAndDelete(req.params.poId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Per-vendor usage stats (PO count + grand-total, distinct order count, and a
// rough actual-spend from the expense ledger), keyed by canonical vendorKey, in a
// few aggregate queries. Used to (a) pick the survivor when the list collapses a
// duplicate group and (b) inform /vendors/duplicates. Leading-zero-safe on order
// numbers isn't needed here (we count POs/txns, not reconcile to orders).
async function _vendorUsageByKey() {
  const [poAgg, txAgg] = await Promise.all([
    PurchaseOrder.aggregate([
      { $match: { archived: { $ne: true } } },
      { $group: { _id: null, rows: { $push: { vendorName: '$vendorName', grandTotal: '$grandTotal', orderId: '$orderId' } } } },
    ]).then((r) => (r[0] && r[0].rows) || []).catch(() => []),
    Transaction.aggregate([
      { $match: { type: 'expense' } },
      { $group: { _id: null, rows: { $push: { party: '$party', amount: '$amount', isCredit: '$isCredit' } } } },
    ]).then((r) => (r[0] && r[0].rows) || []).catch(() => []),
  ]);
  const byKey = new Map();
  const get = (k) => {
    if (!byKey.has(k)) byKey.set(k, { poCount: 0, poTotal: 0, spend: 0, orderIds: new Set() });
    return byKey.get(k);
  };
  for (const p of poAgg) {
    const k = vendorKey(p.vendorName);
    if (!k) continue;
    const s = get(k);
    s.poCount += 1;
    s.poTotal += Number(p.grandTotal) || 0;
    if (p.orderId) s.orderIds.add(String(p.orderId));
  }
  for (const t of txAgg) {
    const k = vendorKey(t.party);
    if (!k) continue;
    get(k).spend += (t.isCredit ? -1 : 1) * (Number(t.amount) || 0);
  }
  // Finalize: orderIds Set → orderCount.
  for (const [, s] of byKey) { s.orderCount = s.orderIds.size; delete s.orderIds; }
  return byKey;
};

// GET /api/orders/vendors — the contact book, for the builder's vendor picker and
// the Vendors list. DEDUPED by canonical identity: likely-duplicate records (a
// bare "Heritage" beside the real "Heritage Screen Printing") collapse to ONE row
// — the survivor (the record WITH details / most POs / most spend) — annotated
// with how many aliases fold in and their ids, so the owner sees a single printer
// and can make the merge permanent from the card. Nothing is deleted here; this is
// a presentation-time fold (the underlying records stay until an explicit merge).
const listVendors = async (_req, res) => {
  try {
    const vendors = await Vendor.find(NOT_ARCHIVED).sort({ name: 1 }).lean();
    const usage = await _vendorUsageByKey();
    const statsOf = (v) => usage.get(vendorKey(v.name)) || { poCount: 0, poTotal: 0, spend: 0, orderCount: 0 };

    // Cluster likely-duplicates; everything not in a cluster passes through as-is.
    const groups = groupVendorDuplicates(vendors);
    const groupedIds = new Set();
    const collapsed = [];
    for (const g of groups) {
      g.forEach((v) => groupedIds.add(String(v._id)));
      const survivor = pickVendorSurvivor(g, statsOf);
      const aliases = g.filter((v) => String(v._id) !== String(survivor._id));
      collapsed.push({
        ...survivor,
        // Surfaced so the UI can show "+N duplicate" and offer a one-tap merge.
        duplicateOf: aliases.map((v) => ({ _id: v._id, name: v.name })),
        aliasCount: aliases.length,
      });
    }
    const singles = vendors.filter((v) => !groupedIds.has(String(v._id)));
    const out = [...singles, ...collapsed]
      .sort((a, b) => String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()));

    res.json({ vendors: out });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/vendors/search?q= — typeahead for the PO builder's printer field.
// Returns vendors whose name/contact/address matches `q`, each with a short detail
// hint + the profile fields the builder pre-fills (contact/address/ship method/
// blanksProvided), so picking one reuses the real record. Deduped like the list
// (one row per canonical printer). Capped; admin-only (whole router is requireAdmin
// so cost data never leaks — this returns only contact-book fields, no $).
const searchVendors = async (req, res) => {
  try {
    const q = String((req.query && req.query.q) || '').trim();
    const vendors = await Vendor.find(NOT_ARCHIVED).sort({ name: 1 }).lean();
    const usage = await _vendorUsageByKey();
    const statsOf = (v) => usage.get(vendorKey(v.name)) || { poCount: 0, poTotal: 0, spend: 0, orderCount: 0 };

    // Collapse duplicates to survivors first so the typeahead never shows both
    // "Heritage" and "Heritage Screen Printing".
    const groups = groupVendorDuplicates(vendors);
    const groupedIds = new Set();
    const survivors = [];
    for (const g of groups) {
      g.forEach((v) => groupedIds.add(String(v._id)));
      survivors.push(pickVendorSurvivor(g, statsOf));
    }
    let list = [...vendors.filter((v) => !groupedIds.has(String(v._id))), ...survivors];

    if (q) {
      const t = q.toLowerCase();
      list = list.filter((v) => [v.name, v.contactName, v.email, v.address, v.shipMethod]
        .filter(Boolean).join(' ').toLowerCase().includes(t));
    }
    list.sort((a, b) => String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()));

    const out = list.slice(0, 25).map((v) => ({
      _id: v._id,
      name: v.name || '',
      contactName: v.contactName || '',
      email: v.email || '',
      phone: v.phone || '',
      address: v.address || '',
      shipMethod: v.shipMethod || '',
      accountNumber: v.accountNumber || '',
      blanksProvided: v.blanksProvided !== false,
      // A compact hint for the dropdown's secondary line (no $ figures).
      hint: [v.contactName, v.address, v.shipMethod].filter(Boolean).join(' · '),
    }));
    res.json({ vendors: out, total: out.length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/po-cost-history?vendor=<name>&q=<term> — "cost memory" for the
// PO builder. Pulls recent POs for a vendor and flattens their order-summary
// charges into rows so the owner can re-use a past line (and see its per-unit
// cost) when pricing the next PO. Read-only; vendor match mirrors the
// case-insensitive exact-name lookup used by createPo/updatePo.
const poCostHistory = async (req, res) => {
  try {
    const vendor = String((req.query && req.query.vendor) || '').trim();
    const q = String((req.query && req.query.q) || '').trim().toLowerCase();
    if (!vendor) return res.json({ vendor: '', rows: [] });

    // Same exact-ish, case-insensitive vendor match the rest of the PO code uses
    // so "heritage" and "Heritage Screen Printing" resolve consistently. The PO
    // cap is the real bound on the work (each PO has only a handful of charges),
    // so cap POS in the QUERY (M2) — not rows after the fact — and lift the row
    // cap to a generous bound that won't bite normal usage.
    const PO_CAP = 60;
    const ROW_CAP = 250;
    const pos = await PurchaseOrder.find({
      vendorName: new RegExp(`^${vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      ...NOT_ARCHIVED,
    })
      .sort({ date: -1, createdAt: -1 })
      .limit(PO_CAP)
      .select('poNumber orderId date charges')
      .lean();

    const rows = [];
    let truncated = false;
    for (const po of pos) {
      for (const c of (po.charges || [])) {
        const label = String((c && c.label) || '');
        if (q && !label.toLowerCase().includes(q)) continue;
        if (rows.length >= ROW_CAP) { truncated = true; break; }
        rows.push({
          poNumber: po.poNumber || '',
          orderId:  po.orderId || null,
          date:     po.date || null,
          label,
          amount:   n(c && c.amount),
          unitCost: parseUnitCost(label),   // null when the line has no per-unit figure
        });
      }
      if (truncated) break;
    }

    // `truncated` lets the UI say "showing the most recent N" instead of silently
    // hiding older rows (M2).
    res.json({ vendor, rows, truncated });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/pos/:poId/pdf — server-rendered PDF in the house format.
const poPdf = async (req, res) => {
  try {
    if (badId(req.params.poId)) return res.status(404).json({ message: 'PO not found' });
    const po = await PurchaseOrder.findById(req.params.poId).lean();
    if (!po) return res.status(404).json({ message: 'PO not found' });

    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const left = doc.page.margins.left;
    const pageW = doc.page.width - left - doc.page.margins.right;
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'po';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="${slug(po.vendorName)}-x-jp-po-${slug(po.poNumber)}.pdf"`);
    doc.pipe(res);

    const INK = '#111111', MUTED = '#555555', GREEN = '#1a3d2b', LINE = '#dddddd';

    // Header: logo + title
    const logoSize = 40;
    try { doc.image(JP_LOGO_PATH, left, left, { fit: [logoSize, logoSize] }); } catch (_) { /* optional */ }
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
      .text(`${po.vendorName || 'Vendor'} x Joint Printing PO`, left + logoSize + 12, left + 12);
    doc.y = left + logoSize + 18;
    doc.moveTo(left, doc.y).lineTo(left + pageW, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(1);

    const field = (label, value) => {
      if (value == null || value === '') return;
      doc.x = left;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`${label}: `, left, doc.y, { width: (pageW - 24) / 2, continued: true });
      doc.font('Helvetica').fillColor(MUTED).text(String(value));
      doc.moveDown(0.15);
    };
    const section = (title) => {
      doc.x = left;
      doc.moveDown(0.7);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(GREEN).text(title, left);
      doc.moveDown(0.3);
    };
    // A, B, … Z, AA, AB … so a long PO never wraps its item letters back to 'A'.
    const alpha = (i, baseCode) => {
      let s = '', x = Math.max(0, i | 0);
      do { s = String.fromCharCode(baseCode + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
      return s;
    };

    // Render a labeled address block (one column). Lays each non-empty line under
    // a small green sub-heading; renders "—" only-if every line is empty so the
    // PO still reads when a block is unfilled (never crashes on missing data).
    const ld = (d) => (d ? new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC' }) : '');
    const addrBlock = (x, w, heading, a, sub) => {
      const obj = a || {};
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GREEN)
        .text(String(heading).toUpperCase(), x, doc.y, { width: w, characterSpacing: 0.5 });
      if (sub) doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(sub, x, doc.y, { width: w });
      doc.moveDown(0.15);
      const lines = [obj.name, obj.attention && `Attn: ${obj.attention}`, obj.streetAddress, obj.cityStateZip]
        .map((s) => String(s || '').trim()).filter(Boolean);
      doc.font('Helvetica').fontSize(9.5).fillColor(INK);
      if (lines.length) lines.forEach((ln) => doc.text(ln, x, doc.y, { width: w }));
      else doc.fillColor(MUTED).text('—', x, doc.y, { width: w });
    };

    // ── Top block: PO meta (left) + vendor/printer (right) ──────────────────────
    doc.x = left;
    const metaTop = doc.y;
    const colW = (pageW - 24) / 2;
    field('Purchase Order Number', po.poNumber);
    field('Date', ld(po.date));
    field('Due / In-hands Date', ld(po.dueDate));
    field('Proof', po.proofRequired ? 'Required before production run' : 'Not required');
    field('Blanks', po.blanksProvided ? 'Provided by Joint Printing' : 'Supplied by printer');

    // Vendor / printer block on the right, vertically aligned with the meta block.
    const rightX = left + colW + 24;
    const afterMeta = doc.y;
    doc.y = metaTop;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GREEN)
      .text('PRINTER / VENDOR', rightX, doc.y, { width: colW, characterSpacing: 0.5 });
    doc.moveDown(0.15);
    const vLines = [po.vendorName, po.contactName && `Attn: ${po.contactName}`, po.vendorAddress]
      .map((s) => String(s || '').trim()).filter(Boolean);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    if (vLines.length) vLines.forEach((ln) => doc.text(ln, rightX, doc.y, { width: colW }));
    else doc.fillColor(MUTED).text('—', rightX, doc.y, { width: colW });
    if (po.shipMethod) {
      doc.moveDown(0.15);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text('Ship method: ', rightX, doc.y, { width: colW, continued: true });
      doc.font('Helvetica').fillColor(INK).text(String(po.shipMethod));
    }
    // Continue below whichever column ran longer.
    doc.y = Math.max(afterMeta, doc.y);

    // ── Two ship-to blocks: blanks → printer (the missing field) + finished goods
    // → client. JP supplies blanks ~99% of the time, so a PO genuinely has both. We
    // ALWAYS show the printer receiving block (falling back to the vendor address)
    // so the "where do the blanks go" address can never be missing again.
    const sp = po.shipToPrinter || {};
    const hasPrinterShip = sp.name || sp.attention || sp.streetAddress || sp.cityStateZip;
    const printerShip = hasPrinterShip ? sp
      : { name: po.vendorName, attention: po.contactName, streetAddress: po.vendorAddress, cityStateZip: '' };
    const sh = po.shipping || {};
    const hasFinalShip = sh.name || sh.attention || sh.streetAddress || sh.cityStateZip;

    section('Shipping');
    const shipTop = doc.y;
    addrBlock(left, colW, 'Ship blanks to (printer)', printerShip, 'Where JP sends the blanks');
    const leftEnd = doc.y;
    doc.y = shipTop;
    addrBlock(rightX, colW, 'Finished goods ship to', hasFinalShip ? sh : null, 'Where the finished order delivers');
    doc.y = Math.max(leftEnd, doc.y);

    if ((po.items || []).length > 0) {
      section(po.blanksProvided ? 'Product/Print Info - (blanks provided)' : 'Product/Print Order Summary');
      po.items.forEach((it, i) => {
        if (!it) return;   // a null array element (malformed save) must not crash the render
        const letter = alpha(i, 65);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
          .text(`${letter})  ${it.title || ''}`, left + 8);
        (it.details || []).filter((d) => d != null).forEach((d, j) => {
          const sub = alpha(j, 97);
          doc.font('Helvetica').fontSize(10).fillColor(MUTED)
            .text(`${sub})  ${d}`, left + 30);
        });
        doc.moveDown(0.3);
      });
    }

    if ((po.charges || []).length > 0) {
      section('Order Summary');
      po.charges.forEach((c) => {
        if (!c) return;   // skip a null charge element rather than throwing mid-PDF
        const rowY = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor(MUTED)
          .text(`•  ${c.label || ''}`, left + 8, rowY, { width: pageW - 110 });
        // Pin the amount to the label's first line so a wrapped label can't
        // drag the figure out of vertical alignment.
        doc.font('Helvetica-Bold').fillColor(INK)
          .text(money(c.amount), left + pageW - 90, rowY, { width: 90, align: 'right' });
        doc.moveDown(0.2);
      });
    }

    if (po.notes) {
      section('Notes');
      doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(po.notes, left + 8, doc.y, { width: pageW - 16 });
    }

    doc.moveDown(1);
    doc.moveTo(left, doc.y).lineTo(left + pageW, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(GREEN)
      .text(`Grand Total: ${money(po.grandTotal)}`, left, doc.y, { width: pageW, align: 'right' });

    doc.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ message: e.message });
  }
};

// ── Per-vendor numbering control ──────────────────────────────────────────────

// Case-insensitive exact-name vendor lookup — the SAME match the PO seeders use,
// so "heritage" and "Heritage" resolve to one record. Returns the POJO or null.
async function _findVendorByName(name) {
  const v = String(name || '').trim();
  if (!v) return null;
  return Vendor.findOne({ name: new RegExp(`^${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), ...NOT_ARCHIVED }).lean();
}

// GET /api/orders/po-next-number?vendor=<name> — the number that WOULD be assigned
// to this vendor's next PO (max of the atomic counter and the owner-set start),
// WITHOUT consuming it. Lets the builder + the vendor card show "next PO #009" and
// the owner adjust it. Read-only; an empty/blank vendor returns the shared default.
const nextPoNumber = async (req, res) => {
  try {
    const vendor = String((req.query && req.query.vendor) || '').trim();
    if (!vendor || isUnassignedVendor(vendor)) return res.json({ vendor, next: null, nextPoStart: 0 });
    const v = await _findVendorByName(vendor);
    const seq = await peekNumber('po', vendor, v && v.nextPoStart);
    res.json({
      vendor,
      next: `#${String(seq).padStart(3, '0')}`,
      nextNumeric: seq,
      nextPoStart: (v && v.nextPoStart) || 0,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── Vendor / printer card (the connected supplier database) ───────────────────

// Build the vendor↔order link set from BOTH the POs issued to a vendor and the
// receipt/expense ledger paid to them, keyed by canonical (leading-zero-safe)
// order number. `vendor` is the Vendor doc (its remembered vendorOrders) merged
// with what the POs/transactions actually show, so the card stays correct even if
// the learned hints lag. Returns a de-duped, recency-sorted list of { orderNumber }.
function _vendorOrderKeys(vendor, posByOrderNum, txns) {
  const keys = new Set();
  (vendor && Array.isArray(vendor.vendorOrders) ? vendor.vendorOrders : [])
    .forEach((l) => { const k = normalizeOrderNumber(l && l.orderNumber); if (k) keys.add(k); });
  Object.keys(posByOrderNum || {}).forEach((k) => { if (k) keys.add(k); });
  (txns || []).forEach((t) => { const k = normalizeOrderNumber(t && t.orderNumber); if (k) keys.add(k); });
  return [...keys];
}

// GET /api/orders/vendors/:id — the full vendor/printer detail card. Aggregates,
// for one supplier, every connected record so clicking a printer shows everything
// about them (the "full database" the owner asked for):
//   • the vendor profile (contact/address/ship method/account #/blanksProvided +
//     the editable next-PO # / owner-set start);
//   • every PO issued to them (newest first, with order link + grand total);
//   • every order/project they printed (matched by the vendor on the PO, by the
//     order# on a receipt paid to them, and by the remembered vendor↔order hints);
//   • every receipt/expense Transaction whose `party` is this vendor (the actual
//     money paid to them), leading-zero-safe on order numbers;
//   • lifetime totals (PO count + value, actual spend, orders, last used).
// Admin-only (the whole router is requireAdmin) — cost detail never leaks client-side.
const getVendor = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Vendor not found' });
    const vendor = await Vendor.findById(req.params.id).lean();
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    // POs issued to this vendor. Narrow in the QUERY with a whitespace-flexible,
    // case-insensitive anchored name regex (so a "Heritage" / "heritage" / double-
    // spaced variant is still pulled) instead of scanning every PO, then keep the
    // exact vendorKey() gate — the SAME normalization used for numbering/grouping —
    // as the precise filter so only this printer's POs count.
    const wantKey = vendorKey(vendor.name);
    const nameRe = new RegExp(`^${String(vendor.name || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}$`, 'i');
    const candidatePos = await PurchaseOrder.find({ vendorName: nameRe, ...NOT_ARCHIVED })
      .select('poNumber vendorName grandTotal orderId date createdAt sourceFileId')
      .sort({ date: -1, createdAt: -1 })
      .lean();
    const vendorPos = candidatePos.filter((p) => vendorKey(p.vendorName) === wantKey);

    // The transactions whose counter-party is this vendor (expense money paid to
    // them). Party is free-text, so match the SAME case-insensitive exact name;
    // these are the real dollars spent with the printer.
    const txns = await Transaction.find({
      type: 'expense',
      party: new RegExp(`^${String(vendor.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    }).select('date amount isCredit category orderNumber description receiptUrl party').lean();

    // Map order ids on POs → their order numbers, so a PO contributes its order to
    // this vendor's "orders they printed". One query for all the linked orders.
    const orderIds = [...new Set(vendorPos.map((p) => String(p.orderId)).filter(Boolean))];
    const ordersById = orderIds.length
      ? await Order.find({ _id: { $in: orderIds } })
          .select('orderNumber projectNumber companyName clientName totalValue paid orderDate status')
          .lean()
      : [];
    const orderById = new Map(ordersById.map((o) => [String(o._id), o]));

    // Canonical-order-number union: every order this vendor touched (via a PO,
    // a receipt paid to them, or a remembered hint). Pull every matching Order
    // (the receipt/hint side can reference an order with no PO yet), over-matching
    // leading-zero variants then filtering canonically — the SAME bridge the
    // finance/CRM code uses. Then hand the POJOs to the pure aggregator.
    const posByOrderNum = {};
    vendorPos.forEach((p) => {
      const o = orderById.get(String(p.orderId));
      const k = o ? normalizeOrderNumber(o.orderNumber) : '';
      if (k) (posByOrderNum[k] ||= []).push(p);
    });
    const orderKeys = _vendorOrderKeys(vendor, posByOrderNum, txns);
    const connectedOrders = orderKeys.length
      ? await Order.find({ orderNumber: { $in: orderKeys.map((k) => new RegExp(`^0*${k}$`)) } })
          .select('orderNumber projectNumber companyName clientName totalValue paid orderDate status')
          .lean()
      : [];

    // The next number this vendor's PO would take (floored by the owner-set start).
    const nextSeq = await peekNumber('po', vendor.name, vendor.nextPoStart);
    const card = aggregateVendorCard({ vendor, vendorPos, txns, connectedOrders, orderById });
    res.json({
      ...card,
      nextPo: { next: `#${String(nextSeq).padStart(3, '0')}`, nextNumeric: nextSeq, nextPoStart: vendor.nextPoStart || 0 },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// PURE vendor-card aggregation (no DB) — exported + unit-tested. Given a vendor's
// already-fetched POJOs (its POs, the expense Transactions paid to it, the Orders
// connected by any path, and a map of orderId→Order for the PO side), produce the
// card payload: per-order rollup (with the printer's spend on each, leading-zero-
// safe), the PO list, the transaction list, and lifetime totals. Mirrors the
// finance signing rule (an expense credit nets spend DOWN) so the vendor's
// lifetime spend reconciles with the ledger. `orderById` is keyed by String(_id).
function aggregateVendorCard({ vendor, vendorPos, txns, connectedOrders, orderById }) {
  const byId = orderById instanceof Map ? orderById : new Map(Object.entries(orderById || {}));
  const pos = Array.isArray(vendorPos) ? vendorPos : [];
  const rows = Array.isArray(txns) ? txns : [];

  // canonical order# → the PO(s) on it.
  const posByOrderNum = {};
  pos.forEach((p) => {
    const o = byId.get(String(p.orderId));
    const k = o ? normalizeOrderNumber(o.orderNumber) : '';
    if (k) (posByOrderNum[k] ||= []).push(p);
  });
  const orderKeys = _vendorOrderKeys(vendor, posByOrderNum, rows);

  // De-dupe connected orders by canonical number; prefer a named one on collision.
  const ordersByKey = new Map();
  (Array.isArray(connectedOrders) ? connectedOrders : []).forEach((o) => {
    const k = normalizeOrderNumber(o && o.orderNumber);
    if (!k) return;
    const cur = ordersByKey.get(k);
    if (!cur || ((o.companyName || o.clientName) && !(cur.companyName || cur.clientName))) ordersByKey.set(k, o);
  });

  // Per-order + lifetime spend — signed so a supplier credit nets down (ledger rule).
  const spendByOrder = {};
  let lifetimeSpend = 0;
  rows.forEach((t) => {
    const amt = (t && t.isCredit ? -1 : 1) * (Number(t && t.amount) || 0);
    lifetimeSpend += amt;
    const k = normalizeOrderNumber(t && t.orderNumber);
    if (k) spendByOrder[k] = (spendByOrder[k] || 0) + amt;
  });

  const orders = orderKeys.map((k) => {
    const o = ordersByKey.get(k) || null;
    const linkedPos = (posByOrderNum[k] || []).map((p) => ({ _id: p._id, poNumber: p.poNumber || '', grandTotal: Number(p.grandTotal) || 0 }));
    return {
      orderNumber: k,
      orderId: o ? o._id : null,
      projectNumber: o ? (o.projectNumber || '') : '',
      company: o ? ((o.companyName || o.clientName || '').trim()) : '',
      totalValue: o ? (Number(o.totalValue) || 0) : 0,
      paid: o ? !!o.paid : false,
      status: o ? (o.status || '') : '',
      orderDate: o ? (o.orderDate || null) : null,
      spend: round2(spendByOrder[k] || 0),
      pos: linkedPos,
    };
  }).sort((a, b) => Number(b.orderNumber) - Number(a.orderNumber));

  const poTotal = pos.reduce((s, p) => s + (Number(p.grandTotal) || 0), 0);
  const lastUsed = pos.length
    ? (pos[0].date || pos[0].createdAt)
    : (rows.length ? rows.map((t) => t.date).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] : null);

  return {
    vendor,
    pos: pos.map((p) => {
      const o = byId.get(String(p.orderId));
      return {
        _id: p._id, poNumber: p.poNumber || '', grandTotal: Number(p.grandTotal) || 0,
        orderId: p.orderId || null,
        orderNumber: o ? normalizeOrderNumber(o.orderNumber) : '',
        projectNumber: o ? (o.projectNumber || '') : '',
        date: p.date || null,
      };
    }),
    orders,
    transactions: rows
      .map((t) => ({
        _id: t._id, date: t.date || null, amount: Number(t.amount) || 0, isCredit: !!t.isCredit,
        category: t.category || '', orderNumber: normalizeOrderNumber(t.orderNumber),
        description: t.description || '', hasReceipt: !!t.receiptUrl,
      }))
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)),
    totals: {
      poCount: pos.length,
      poTotal: round2(poTotal),
      lifetimeSpend: round2(lifetimeSpend),
      orderCount: orders.length,
      lastUsed: lastUsed || null,
    },
  };
}

// PATCH /api/orders/vendors/:id — owner edits to a vendor's card: contact/address/
// ship method/account #/blanksProvided default, and the per-vendor NEXT-PO START
// (#1). Setting a higher start floors future auto-numbering AND immediately bumps
// the atomic counter up to it, so the next PO can't collide with the owner's real
// run. Never lowers an already-issued sequence below what's been used.
const VENDOR_PATCHABLE = ['name', 'contactName', 'email', 'phone', 'address', 'shipMethod', 'accountNumber', 'notes', 'blanksProvided'];
const updateVendor = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Vendor not found' });
    const body = req.body || {};
    const set = {};
    for (const f of VENDOR_PATCHABLE) {
      if (f in body) set[f] = f === 'blanksProvided' ? !!body[f] : body[f];
    }
    // The owner-set next-PO start. Clamp to a non-negative integer; 0 clears it.
    let bumpStart = null;
    if ('nextPoStart' in body) {
      const s = Math.max(0, parseInt(body.nextPoStart, 10) || 0);
      set.nextPoStart = s;
      bumpStart = s;
    }
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, { $set: set }, { new: true, runValidators: true }).lean();
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    // Raise the atomic per-vendor counter to floor-1 so the very next auto number
    // is exactly the owner-set start (kept collision-safe; never moves it back).
    if (bumpStart && bumpStart > 0) await bumpCounterTo('po', bumpStart - 1, vendor.name);

    const nextSeq = await peekNumber('po', vendor.name, vendor.nextPoStart);
    res.json({ vendor, nextPo: { next: `#${String(nextSeq).padStart(3, '0')}`, nextNumeric: nextSeq, nextPoStart: vendor.nextPoStart || 0 } });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

// ── Vendor dedup detection + merge (mirror of the CRM cleanup tooling) ────────

// GET /api/orders/vendors/duplicates — groups of likely-same vendors with a
// suggested survivor (the record WITH details / most POs / most spend). Mirrors
// CRM getDuplicates: PROPOSE only; merging is an explicit, reversible owner act.
// Admin-only (whole router is requireAdmin). Conservative grouping (utils/
// vendorMatch.groupVendorDuplicates) so two genuinely-different printers never
// land in the same group.
const vendorDuplicates = async (_req, res) => {
  try {
    const vendors = await Vendor.find(NOT_ARCHIVED).lean();
    const usage = await _vendorUsageByKey();
    const statsOf = (v) => usage.get(vendorKey(v.name)) || { poCount: 0, poTotal: 0, spend: 0, orderCount: 0 };

    const groups = groupVendorDuplicates(vendors);
    const out = groups.map((g) => {
      const survivor = pickVendorSurvivor(g, statsOf);
      return {
        // Stable group id for the UI key (the survivor's match stem).
        matchKey: vendorMatchKey(survivor.name) || vendorKey(survivor.name),
        suggestedSurvivor: String(survivor._id),
        members: g.map((v) => {
          const s = statsOf(v);
          return {
            _id: String(v._id),
            name: v.name || '',
            contactName: v.contactName || '',
            address: v.address || '',
            shipMethod: v.shipMethod || '',
            hasDetails: ['contactName', 'email', 'phone', 'address', 'shipMethod', 'accountNumber']
              .some((f) => String(v[f] || '').trim()),
            poCount: s.poCount,
            poTotal: round2(s.poTotal),
            spend: round2(s.spend),
            orderCount: s.orderCount,
            learnedLinks: Array.isArray(v.vendorOrders) ? v.vendorOrders.length : 0,
          };
        }),
      };
    });
    // Most-actionable first: groups whose members carry POs/spend, then by size.
    out.sort((a, b) =>
      (b.members.some((m) => m.poCount || m.spend) ? 1 : 0) - (a.members.some((m) => m.poCount || m.spend) ? 1 : 0)
      || b.members.length - a.members.length);

    res.json({ groups: out, total: out.length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/vendors/merge { survivor, merged }
// Fold the merged vendor's profile blanks + notes + learned order links into the
// survivor, RE-POINT every record that referenced the merged vendor BY NAME to
// the survivor's name — its POs (vendorName + shipToPrinter.name), its expense
// Transactions (party), — then soft-delete (archive) the merged record. Mirrors
// CRM mergeCompanies: preserves ALL data; re-points BEFORE delete; recoverable.
// `survivor`/`merged` are Vendor ids.
const mergeVendors = async (req, res) => {
  try {
    const survivorId = String((req.body && req.body.survivor) || '').trim();
    const mergedId   = String((req.body && req.body.merged) || '').trim();
    if (!survivorId || !mergedId) return res.status(400).json({ message: 'survivor and merged ids are required' });
    if (survivorId === mergedId)   return res.status(400).json({ message: 'survivor and merged must differ' });
    if (badId(survivorId) || badId(mergedId)) return res.status(404).json({ message: 'Vendor not found' });

    const survivor = await Vendor.findById(survivorId);
    const merged   = await Vendor.findById(mergedId);
    if (!survivor) return res.status(404).json({ message: 'survivor vendor not found' });
    if (!merged)   return res.status(404).json({ message: 'merged vendor not found' });
    if (merged.archived) return res.status(400).json({ message: 'merged vendor is already archived' });

    const survivorName = survivor.name || '';
    const mergedName = merged.name || '';

    // Fold profile blanks + notes + learned links into the survivor (pure policy,
    // leading-zero-safe on the order links via normalizeOrderNumber).
    foldVendorFields(survivor, merged, normalizeOrderNumber);
    await survivor.save();

    // RE-POINT everything that referenced the merged vendor to the survivor's
    // name. We match by CANONICAL vendorKey, not exact bytes — a PO/receipt saved
    // with a whitespace variant ("Heritage  Screen Printing", a leading space)
    // shares the merged vendor's vendorKey and legitimately belongs to it (the
    // vendor CARD surfaces those via the same whitespace-flexible match), so the
    // re-point must be just as tolerant or those records orphan on the archive.
    // A whitespace-flexible anchored regex narrows the query; the exact vendorKey
    // gate is the precise filter (identical to getVendor). Skip the whole block on
    // a same-key merge (a pure case/whitespace alias collapse) — the survivor's
    // card already matches those POs case-insensitively, so nothing orphans.
    const mergedKeyVal = vendorKey(mergedName);
    const wsRe = (s) => new RegExp(`^${String(s || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}$`, 'i');
    let posRepointed = 0;
    let txnsRepointed = 0;
    if (mergedName && mergedKeyVal && mergedKeyVal !== vendorKey(survivorName)) {
      const mergedNameRe = wsRe(mergedName);
      // POs: vendorName (and keep the printer receiving-block name in sync where it
      // equals the old name). Filter to the exact vendorKey so only this printer's
      // POs move, even though the regex over-matches whitespace variants.
      const candidatePos = await PurchaseOrder.find({
        $or: [{ vendorName: mergedNameRe }, { 'shipToPrinter.name': mergedNameRe }],
      }).select('vendorName shipToPrinter').lean();
      for (const p of candidatePos) {
        const set = {};
        if (vendorKey(p.vendorName) === mergedKeyVal) set.vendorName = survivorName;
        if (p.shipToPrinter && vendorKey(p.shipToPrinter.name) === mergedKeyVal) set['shipToPrinter.name'] = survivorName;
        if (Object.keys(set).length === 0) continue;
        // eslint-disable-next-line no-await-in-loop
        await PurchaseOrder.updateOne({ _id: p._id }, { $set: set });
        if (set.vendorName) posRepointed += 1;
      }

      // Expense Transactions: re-point the counter-party (the dollars paid).
      const candidateTx = await Transaction.find({ type: 'expense', party: mergedNameRe })
        .select('party').lean();
      const txIds = candidateTx.filter((t) => vendorKey(t.party) === mergedKeyVal).map((t) => t._id);
      if (txIds.length) {
        const txUpd = await Transaction.updateMany(
          { _id: { $in: txIds } },
          { $set: { party: survivorName } },
        );
        txnsRepointed = txUpd.modifiedCount != null ? txUpd.modifiedCount : (txUpd.nModified || 0);
      }
    }
    // The learned receipt→vendor links lived on the merged Vendor doc itself and
    // were already folded into the survivor by foldVendorFields above — re-saving
    // the survivor (done) is the re-point for those.

    // Soft-delete the merged record (recoverable; nothing hard-deleted).
    merged.archived = true;
    merged.archivedAt = new Date();
    merged.archivedReason = 'merged';
    merged.mergedInto = survivor._id;
    await merged.save();

    // Keep the survivor's per-vendor PO counter collision-safe with any number it
    // just absorbed (the merged vendor's run may have been ahead).
    if (survivor.nextPoStart && survivor.nextPoStart > 0) {
      await bumpCounterTo('po', survivor.nextPoStart - 1, survivorName).catch(() => {});
    }

    res.json({
      ok: true,
      survivor: survivor.toObject(),
      posRepointed,
      txnsRepointed,
      mergedId,
    });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

module.exports = {
  listPos, createPo, createPosFromConfirmation, updatePo, deletePo, listVendors,
  poCostHistory, poPdf, parseUnitCost, nextPoNumber, getVendor, updateVendor,
  searchVendors, vendorDuplicates, mergeVendors,
};
// Exported for unit tests — pure helpers for the multi-location ship-split PO output.
module.exports._itemShipSplit = _itemShipSplit;
module.exports._shipNotes = _shipNotes;
module.exports._seedPoForGroup = _seedPoForGroup;
module.exports._seedFromOrder = _seedFromOrder;
module.exports._groupConfBySupplier = _groupConfBySupplier;
module.exports._quoteLineIndex = _quoteLineIndex;
// Pure vendor-card aggregation (no DB) — exported for unit tests.
module.exports.aggregateVendorCard = aggregateVendorCard;
module.exports._vendorOrderKeys = _vendorOrderKeys;
