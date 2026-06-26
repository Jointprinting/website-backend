// services/vendorRebuild.js
//
// PURE reconcile logic for the owner-triggered "Rebuild printers from Drive" flow —
// the VENDOR/PO analogue of services/crmReconcile.js + services/financeRestart.js.
// No DB, no Express, no I/O: every function takes plain data in and returns plain
// data out, so the whole rebuild is unit-testable and the controller stays a thin
// wrapper that (a) loads the committed seed + the current DB state, (b) calls
// buildRebuildPlan, then (c) applies it.
//
// WHAT THE REBUILD DOES (mirrors the CRM/finance reconcile shape):
//   • The owner's REAL printer/PO history lives in a Google Drive "POs" folder —
//     one subfolder per printer, each holding that printer's PO docs. The in-app
//     vendor data was near-empty / auto-created. This loads the 16 real printers
//     (enriched with their actual spend from the verified finance ledger) and their
//     PurchaseOrder records, and ARCHIVES (soft, recoverable) the old auto-created
//     in-app vendors/POs that the rebuild supersedes.
//
// SAFETY INVARIANTS (enforced here + in the controller, and unit-tested):
//   • PRESERVE the owner's one real in-app PO — the Happy Leaf order's PO — matched
//     by order/client; it is NEVER archived (it isn't a Drive-folder printer).
//   • Identity is the canonical vendor name (the folder title). Name variants in the
//     ledger/docs ("Heritage" / "Heritage Screen Printing", "Blue Frog" / "BlueFrog")
//     fold onto ONE canonical vendor via utils/vendorMatch — never two cards.
//   • Idempotent: a re-run creates/loads/archives only what's missing (the plan's
//     toCreate/toLoad/toArchive are computed against current state).
//   • Reversible: every touched record is stamped with a batchId; the old records
//     are SOFT-archived (recoverable), never hard-deleted.
//   • POs link to orders by orderNumber where the Drive client maps to a known
//     order; an unmatched PO still loads (vendor-only), never blocks.

const {
  vendorKey, sameVendor, resolveVendorFromList, isRealVendorName,
} = require('../utils/vendorMatch');

// ── The 16 printer folders (canonical vendor name == folder title) ────────────
// Recorded here (not just in the build script) so the controller + tests can map a
// vendor name → its Drive folder for provenance and the "is this a Drive printer"
// test that decides what to archive vs preserve.
const VENDOR_FOLDERS = [
  { title: 'Heritage Screen Printing', id: '1c3VAN0FSw2AyHk8TpYuC0lyjW36sqCpo' },
  { title: 'Cannabis Promotions',      id: '1KL9ARRLlxdpvM0JYLhVPofVZGN_NsLST' },
  { title: 'Worldwide Promotion Inc',  id: '10WkVwHyu5E8uY4qGoAZPGJ5_PVV91tle' },
  { title: 'Ace Screen Printing',      id: '1tpm3ify0-i40Csi2MOGep4uPF7cXxVuB' },
  { title: 'East End Ink',             id: '1xnHG7fht-k9ZIgATpvgrcdXiRsp2qn6z' },
  { title: 'Full Designs',             id: '1i7vv5tf1uN1ZHQFK6tfu10aDIOeCE272' },
  { title: 'Contract-DTG',             id: '1L-NNhkNFshCS_4Ep7B65v2AsN7ifsftu' },
  { title: 'Global Promo',             id: '1xOOW-OM-kokDOmKYZF9mvoZeuWb0cYos' },
  { title: 'BIC',                      id: '14xmC4VUidKRTQCFoSsQ2Is07U8AQePJ2' },
  { title: 'Cole Apparel',             id: '1ApYYJ07Xn_BvQmi0_7L9N47xgl2lSZZs' },
  { title: 'BlueFrog',                 id: '1Sa5l9kWzdqWKzFiwMgWEfNbpe5MflbiF' },
  { title: 'Apollo',                   id: '1y_-IFP8gz1bSCHPA67bZ-QqfUombaa6X' },
  { title: 'Oklahoma Ink',             id: '1c1HQ0VNrt28F5oerRZlRlgfdTr73cSJu' },
  { title: 'RedTupid',                 id: '1rLb0gpfZaEnhcP3iv44aO4P7X_g2Q61j' },
  { title: 'TekWeld',                  id: '1_yGGxtpuhfF_Asdmy61rl0JlknwPrCFT' },
  { title: 'Stahls DFC',               id: '1Z52QFxF_CwYj46rE9loIp_U1-NCT_vpa' },
];

// Normalize a raw order number to its canonical digits-only key (no leading zeros).
// MUST match controllers/finances.js#normalizeOrderNumber byte-for-byte so a PO's
// order links to the same order/finance row. Kept inline so this stays DB-free.
function normalizeOrderNumber(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');
}

// Resolve a free-text vendor name to one of the canonical folder names, or '' when
// none matches. Order: (0) an EXPLICIT alias the owner recorded (the seed's per-
// vendor aliases — catches the ledger's typo "Hertage Screen Printing" and the
// distinguishing-word variants "Apollo East" / "Bic World" that the conservative
// fuzzy test deliberately won't auto-merge); (1) exact canonical-key; (2) the
// conservative sameVendor test, resolved ONLY when exactly one folder matches
// (never guesses across two). Reuses utils/vendorMatch so the dedup is the SAME
// logic the rest of the app uses. `names` defaults to the 16 folder titles;
// `aliasMap` is { canonicalName → [alias, …] } (defaults to none).
function canonicalVendorName(name, names = VENDOR_FOLDERS.map((f) => f.title), aliasMap = null) {
  const raw = String(name || '').trim();
  if (!isRealVendorName(raw)) return '';
  const want = vendorKey(raw);
  // (0) explicit owner-recorded alias.
  if (aliasMap) {
    for (const [canon, aliases] of (aliasMap instanceof Map ? aliasMap : Object.entries(aliasMap))) {
      if (vendorKey(canon) === want) return canon;
      if ((aliases || []).some((a) => vendorKey(a) === want)) return canon;
    }
  }
  // (1) exact canonical-key.
  const exact = names.find((n) => vendorKey(n) === want);
  if (exact) return exact;
  // (2) resolveVendorFromList is ambiguity-safe (returns null on >1 distinct match).
  const resolved = resolveVendorFromList(raw, names.map((n) => ({ name: n })));
  if (resolved) return resolved.name;
  // Fall back to a single conservative sameVendor hit.
  const hits = names.filter((n) => sameVendor(raw, n));
  return hits.length === 1 ? hits[0] : '';
}

// Build a { canonicalName → [alias,…] } map from a rehydrated dataset's vendors, so
// the plan canonicalizes live names the SAME way the seed builder folded ledger
// spend. Pure helper used by buildRebuildPlan.
function aliasMapFromDataset(dataset) {
  const m = new Map();
  for (const v of (dataset && Array.isArray(dataset.vendors) ? dataset.vendors : [])) {
    m.set(v.name, Array.isArray(v.aliases) ? v.aliases : []);
  }
  return m;
}

// ── Rehydrate the committed seed JSON into the dataset shape the plan expects ──
// The seed (data/vendorPoSeed.json, built by scripts/buildVendorPoSeed.js) carries
// vendors[] + purchaseOrders[] already canonical. This normalizes/guards it.
function rehydrateDataset(seed = {}) {
  const vendors = (Array.isArray(seed.vendors) ? seed.vendors : []).map((v) => ({
    name: String(v.name || '').trim(),
    folderId: v.folderId || '',
    aliases: Array.isArray(v.aliases) ? v.aliases.filter(Boolean) : [],
    contactName: v.contactName || '',
    email: v.email || '',
    phone: v.phone || '',
    address: v.address || '',
    shipMethod: v.shipMethod || '',
    totalSpend: Number(v.totalSpend) || 0,
    orderNumbers: (Array.isArray(v.orderNumbers) ? v.orderNumbers : []).map((n) => normalizeOrderNumber(n)).filter(Boolean),
    poCount: Number(v.poCount) || 0,
    nextPoStart: Number(v.nextPoStart) || 0,
  })).filter((v) => isRealVendorName(v.name));

  const purchaseOrders = (Array.isArray(seed.purchaseOrders) ? seed.purchaseOrders : []).map((p) => ({
    vendorName: String(p.vendorName || '').trim(),
    poNumber: String(p.poNumber || '').trim(),
    date: p.date || null,
    client: p.client || '',
    grandTotal: p.grandTotal == null ? null : Number(p.grandTotal),
    sourceFileId: p.sourceFileId || '',
    sourceTitle: p.sourceTitle || '',
    orderNumber: p.orderNumber ? normalizeOrderNumber(p.orderNumber) : '',
    flags: Array.isArray(p.flags) ? p.flags : [],
  }));

  return {
    vendors,
    purchaseOrders,
    skippedDocs: Array.isArray(seed.skippedDocs) ? seed.skippedDocs : [],
    flaggedDocs: Array.isArray(seed.flaggedDocs) ? seed.flaggedDocs : [],
    summary: seed.summary || {},
  };
}

// ── Does this in-app order look like the owner's real Happy Leaf order? ────────
// The one PO he made by hand in-app is on the Happy Leaf order. We must NOT archive
// that PO. We identify the order by company/client name containing "happy leaf"
// (case-insensitive), since it has no Drive-folder printer. Pure: takes the order's
// comparable name string.
const HAPPY_LEAF_RE = /happy\s*leaf/i;
function isHappyLeafName(name) {
  return HAPPY_LEAF_RE.test(String(name || ''));
}

// A PO is PRESERVED (never archived) when its linked order is the Happy Leaf order.
// `orderNameById` maps String(orderId) → the order's company/client name. A PO whose
// vendor canonicalizes to a Drive folder is a Drive printer's and is replaced; the
// Happy-Leaf guard is the explicit owner-PO carve-out on top of that.
function poIsPreserved(po, orderNameById) {
  const nm = orderNameById instanceof Map
    ? orderNameById.get(String(po.orderId))
    : (orderNameById || {})[String(po.orderId)];
  if (isHappyLeafName(nm)) return true;
  // Also honor an explicit name on the PO/vendor for safety (some POs carry the
  // client/company on the doc itself).
  if (isHappyLeafName(po.vendorName) || isHappyLeafName(po.contactName)) return true;
  return false;
}

// ── Stage: dataset + current DB state → the PLAN the apply consumes VERBATIM ───
//
// buildRebuildPlan(dataset, current, opts) where:
//   current = {
//     vendors: [ { _id, name, archived, nextPoStart, source, createdAt } ],  // ALL live Vendor docs (lean)
//     pos:     [ { _id, vendorName, poNumber, orderId, archived, source } ],  // ALL live PurchaseOrder docs (lean)
//     orders:  [ { _id, orderNumber, companyName, clientName } ],            // orders, for linking + Happy-Leaf id
//   }
// Returns:
//   {
//     vendorsToCreate:  [ vendorSeed ],          // canonical printers not yet present
//     vendorsToUpdate:  [ { name, _id, seed } ], // present (by canonical key) → enrich
//     posToLoad:        [ { ...poSeed, orderId? } ],   // Drive POs not yet present
//     posAlreadyPresent:[ poSeed ],              // same vendor+poNumber already loaded
//     vendorsToArchive: [ { _id, name } ],       // old auto-created in-app vendors superseded
//     posToArchive:     [ { _id, vendorName, poNumber } ],  // old in-app POs superseded
//     preservedPos:     [ { _id, reason } ],     // the Happy-Leaf PO + any carve-outs (kept)
//     flagged:          [ ... ],                 // flagged/uncertain Drive docs (review list)
//     summary:          { ... },
//   }
function buildRebuildPlan(dataset, current = {}, opts = {}) {
  const ds = dataset || { vendors: [], purchaseOrders: [] };
  const liveVendors = Array.isArray(current.vendors) ? current.vendors : [];
  const livePos = Array.isArray(current.pos) ? current.pos : [];
  const orders = Array.isArray(current.orders) ? current.orders : [];

  const canonNames = ds.vendors.map((v) => v.name);
  const aliasMap = aliasMapFromDataset(ds);
  // Local canonicalizer bound to THIS dataset's names + aliases, so live-vendor and
  // PO-vendor folding matches exactly how the seed builder folded ledger spend.
  const canon = (nm) => canonicalVendorName(nm, canonNames, aliasMap);

  // Order lookups: by normalized number (for PO→order linking), by id→name (for the
  // Happy-Leaf preserve test), and by a normalized COMPANY key (for linking a Drive
  // PO to its order via the client/merch line when the seed carried no order number).
  const orderByNum = new Map();
  const orderNameById = new Map();
  const orderByCompanyKey = new Map();
  // "Plantabis Merch" / "The CannaBoss Lady Merch" → a comparable key: lowercase,
  // drop a trailing "merch", drop "the ", strip to [a-z0-9]. Conservative — only an
  // UNAMBIGUOUS single match links (a key claimed by >1 order won't link).
  const companyMatchKey = (s) => String(s || '')
    .toLowerCase().replace(/\bmerch\b/g, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
  const companyKeyOwners = new Map(); // key → Set(orderId) to detect ambiguity
  for (const o of orders) {
    const k = normalizeOrderNumber(o.orderNumber);
    if (k && !orderByNum.has(k)) orderByNum.set(k, o);
    orderNameById.set(String(o._id), o.companyName || o.clientName || '');
    for (const nm of [o.companyName, o.clientName]) {
      const ck = companyMatchKey(nm);
      if (!ck) continue;
      if (!companyKeyOwners.has(ck)) companyKeyOwners.set(ck, new Set());
      companyKeyOwners.get(ck).add(String(o._id));
      if (!orderByCompanyKey.has(ck)) orderByCompanyKey.set(ck, o);
    }
  }
  // Resolve a Drive PO's client to a single order, or null. By the vendor's ledger
  // order numbers first (exact), else by an UNAMBIGUOUS company-key match.
  const linkOrderFor = (po) => {
    if (po.orderNumber && orderByNum.has(po.orderNumber)) return orderByNum.get(po.orderNumber);
    const ck = companyMatchKey(po.client);
    if (ck && companyKeyOwners.has(ck) && companyKeyOwners.get(ck).size === 1) return orderByCompanyKey.get(ck);
    return null;
  };

  // ── Vendors: create vs update by canonical key ──
  const liveVendorByKey = new Map();
  for (const v of liveVendors) {
    if (v.archived) continue;
    const k = vendorKey(v.name);
    if (k && !liveVendorByKey.has(k)) liveVendorByKey.set(k, v);
  }
  // Also fold a live vendor whose name is a variant of a canonical folder name onto
  // that canonical key, so "Heritage" (live) updates the "Heritage Screen Printing"
  // seed instead of being left as a stray + a new dupe created.
  const canonKeyForLive = (v) => {
    const exactSeed = ds.vendors.find((sv) => vendorKey(sv.name) === vendorKey(v.name));
    if (exactSeed) return vendorKey(exactSeed.name);
    const cn = canon(v.name);
    return cn ? vendorKey(cn) : '';
  };

  const vendorsToCreate = [];
  const vendorsToUpdate = [];
  for (const sv of ds.vendors) {
    const key = vendorKey(sv.name);
    // A live vendor matches if its name canonicalizes to this seed vendor.
    const live = liveVendors.find((v) => !v.archived && canonKeyForLive(v) === key);
    if (live) vendorsToUpdate.push({ _id: live._id, name: sv.name, liveName: live.name, seed: sv });
    else vendorsToCreate.push(sv);
  }

  // ── Purchase orders: load vs already present (by canonical vendor + poNumber) ──
  // Signature is canonical-vendor-key + normalized PO number, so a re-run that
  // already loaded "Heritage #008" is a no-op. (Dup PO numbers in the Drive set —
  // e.g. two Cole #0001 — are distinguished by sourceFileId so BOTH load once.)
  const poSig = (vendorName, poNumber, sourceFileId) =>
    `${vendorKey(canon(vendorName) || vendorName)}::${String(poNumber || '').trim().toLowerCase()}::${sourceFileId || ''}`;
  // Live POs that came from a PRIOR rebuild are matched by sourceFileId; live POs
  // from the app carry no sourceFileId, so they never collide with a Drive doc.
  const livePoSigs = new Set();
  for (const p of livePos) {
    if (p.archived) continue;
    if (p.sourceFileId) livePoSigs.add(poSig(p.vendorName, p.poNumber, p.sourceFileId));
  }

  const posToLoad = [];
  const posAlreadyPresent = [];
  for (const p of ds.purchaseOrders) {
    const sig = poSig(p.vendorName, p.poNumber, p.sourceFileId);
    if (livePoSigs.has(sig)) { posAlreadyPresent.push(p); continue; }
    // Link to an order by the seed's order number (exact) OR by an unambiguous
    // match of the Drive client/merch line to an order's company/client name.
    const linkedOrder = linkOrderFor(p);
    posToLoad.push({
      ...p,
      vendorName: canon(p.vendorName) || p.vendorName,
      orderId: linkedOrder ? linkedOrder._id : null,
      linkedOrderNumber: linkedOrder ? normalizeOrderNumber(linkedOrder.orderNumber) : '',
    });
  }

  // ── Archive vs preserve the OLD in-app vendors/POs ──
  // We archive a live VENDOR when it is superseded by a canonical Drive printer
  // (its name canonicalizes to a folder) AND it is not itself one of the canonical
  // records we're updating in place. In practice the in-app data is near-empty;
  // any auto-created vendor that maps to a Drive printer is folded by being the
  // update target (kept), so the archive list is for stray/legacy variants that do
  // NOT become an update target. We are CONSERVATIVE: only archive a vendor that
  // (a) maps to a Drive printer, (b) is NOT the chosen update target for that
  // printer, and (c) is a pure auto/import record (never an owner-curated one).
  const updateTargetIds = new Set(vendorsToUpdate.map((u) => String(u._id)));
  const archivableSources = new Set(['', 'auto', 'import', 'po', 'receipt', undefined, null]);
  const vendorsToArchive = [];
  if (opts.archiveSuperseded !== false) {
    for (const v of liveVendors) {
      if (v.archived) continue;
      if (updateTargetIds.has(String(v._id))) continue;       // it's the survivor we enrich
      const cn = canon(v.name);
      if (!cn) continue;                                       // not a Drive printer → leave it alone
      if (!archivableSources.has(v.source)) continue;          // owner-curated → never auto-archive
      vendorsToArchive.push({ _id: v._id, name: v.name, canonical: cn });
    }
  }

  // Archive OLD in-app POs that belong to a Drive printer (superseded by the Drive
  // history) — EXCEPT (1) the preserved Happy-Leaf PO, (2) POs we just decided are
  // "already present" from a prior rebuild (those stay, idempotent), (3) any PO that
  // already carries a sourceFileId (a prior-rebuild PO; left as-is unless re-loaded).
  const preservedPos = [];
  const posToArchive = [];
  if (opts.archiveSuperseded !== false) {
    for (const p of livePos) {
      if (p.archived) continue;
      if (poIsPreserved(p, orderNameById)) { preservedPos.push({ _id: p._id, vendorName: p.vendorName, poNumber: p.poNumber, reason: 'happy-leaf-owner-po' }); continue; }
      if (p.sourceFileId) continue;                            // a prior-rebuild PO — not an old in-app one
      const cn = canon(p.vendorName);
      if (!cn) { preservedPos.push({ _id: p._id, vendorName: p.vendorName, poNumber: p.poNumber, reason: 'non-drive-printer' }); continue; }
      posToArchive.push({ _id: p._id, vendorName: p.vendorName, poNumber: p.poNumber, canonical: cn });
    }
  }

  const flagged = (ds.purchaseOrders.filter((p) => (p.flags || []).length > 0)
    .map((p) => ({ vendorName: p.vendorName, poNumber: p.poNumber, sourceTitle: p.sourceTitle, flags: p.flags })))
    .concat((ds.skippedDocs || []).map((s) => ({ vendorName: s.vendorName, poNumber: s.poNumber, sourceTitle: s.sourceTitle, flags: s.flags || [s.reason], skipped: true })));

  const plan = {
    vendorsToCreate,
    vendorsToUpdate,
    posToLoad,
    posAlreadyPresent,
    vendorsToArchive,
    posToArchive,
    preservedPos,
    flagged,
  };
  plan.summary = summarizeRebuildPlan(plan, ds);
  return plan;
}

function summarizeRebuildPlan(plan, dataset) {
  const posLinked = plan.posToLoad.filter((p) => p.orderId).length;
  return {
    vendorsToCreate: plan.vendorsToCreate.length,
    vendorsToUpdate: plan.vendorsToUpdate.length,
    vendorsTotal: dataset ? dataset.vendors.length : (plan.vendorsToCreate.length + plan.vendorsToUpdate.length),
    posToLoad: plan.posToLoad.length,
    posAlreadyPresent: plan.posAlreadyPresent.length,
    posLinkedToOrders: posLinked,
    vendorsToArchive: plan.vendorsToArchive.length,
    posToArchive: plan.posToArchive.length,
    preservedPos: plan.preservedPos.length,
    flagged: plan.flagged.length,
    totalSpend: dataset ? Math.round((dataset.vendors.reduce((s, v) => s + (Number(v.totalSpend) || 0), 0)) * 100) / 100 : 0,
    // A re-run would change nothing once everything's created/loaded/archived.
    noOp: plan.vendorsToCreate.length === 0
       && plan.posToLoad.length === 0
       && plan.vendorsToArchive.length === 0
       && plan.posToArchive.length === 0,
  };
}

module.exports = {
  VENDOR_FOLDERS,
  canonicalVendorName,
  aliasMapFromDataset,
  normalizeOrderNumber,
  rehydrateDataset,
  buildRebuildPlan,
  summarizeRebuildPlan,
  isHappyLeafName,
  poIsPreserved,
};
