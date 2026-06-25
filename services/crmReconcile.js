// services/crmReconcile.js
//
// PURE reconcile logic for the owner-triggered "load / reconcile my data" flow.
// No DB, no Express, no I/O — every function here takes plain data in and returns
// plain data out, so the whole reconcile can be unit-tested against the real CSV
// and the endpoints stay thin wrappers that just (a) query current DB state, then
// (b) call buildReconcilePlan, then (c) apply it.
//
// THE THREE PURE STAGES
//   1. buildCleanDataset(csv)                 CSV text → a clean, deduped dataset
//      → { clients, orders, discrepancies, junk, skipped, summary }
//   2. detectDiscrepancies(dataset, rawRows)  structured "things to review" list
//   3. buildReconcilePlan(dataset, current)   dataset + current DB → the PLAN
//      → { clientsToCreate, clientsToUpdate, metaAdJunkToArchive,
//          otherBadImportToArchive, ordersToLoad, discrepancies, summary }
//
// SAFETY INVARIANTS (enforced + tested):
//   • Meta-ad rows are SKIPPED from the real-client set and listed for ARCHIVE
//     (soft, reversible) — never loaded as clients, never hard-deleted.
//   • Cold prospects and Lost/past orders are KEPT (real records the owner
//     re-contacts), never archived as junk.
//   • Dedup is corp-suffix-aware on matchKey for PROPOSALS but identity is the
//     exact companyKey — two genuinely-distinct companies are never merged.
//   • The plan the preview returns is the SAME object the apply consumes, so what
//     the owner confirms is exactly what runs.

const {
  parseCsv, rowsToObjectsWithMeta, mapTrackerRow,
  deriveCompanyKey, matchKey: deriveMatchKey,
  mapLeadSource, parseAliasNames,
  parseMoney, orderStatusImpliesOrder,
} = require('../utils/fieldTrackerImport');

// The exact Notion Status value that marks the bad one-click-import junk. Matched
// case-insensitively as a trimmed substring so spacing/case variants still catch.
const META_AD_STATUS_RE = /meta\s*ad/i;
function isMetaAdStatus(statusRaw) {
  return META_AD_STATUS_RE.test(String(statusRaw || ''));
}

// Map a Notion "Order Status" multi-select / a CRM Status into an Order.status
// enum value for a HISTORICAL order. Conservative: a completed/paid/delivered
// state → 'delivered'; in-flight (mockups/quoting/awaiting approval/production) →
// 'in_production' unless it's purely a quote/lead. We deliberately never invent
// 'placed' vs 'delivered' beyond what the words say; the owner reviews anything
// ambiguous via the discrepancy list. Returns one of the Order enum strings.
function deriveOrderStatus(orderStatusRaw, crmStatusRaw) {
  const v = `${orderStatusRaw || ''} ${crmStatusRaw || ''}`.toLowerCase();
  // "cancel" as a prefix so "cancelled" / "canceled" / "cancellation" all catch
  // (a trailing \b would miss them); void/dead are whole words.
  if (/\bcancel|\b(void|dead)\b/.test(v)) return 'cancelled';
  if (/(deliver|fulfilled|received)/.test(v)) return 'delivered';
  if (/(shipped|in transit)/.test(v)) return 'shipped';
  if (/(complete|paid|won)/.test(v)) return 'delivered';
  if (/(production|printing|in production)/.test(v)) return 'in_production';
  if (/(mockup|awaiting client approval|approved)/.test(v)) return 'approved';
  if (/(quot|invoice)/.test(v)) return 'quoted';
  return 'quoted';
}

// Was the money paid? Only an explicit "paid"/"completed" order state says yes.
function deriveOrderPaid(orderStatusRaw, crmStatusRaw) {
  const v = `${orderStatusRaw || ''} ${crmStatusRaw || ''}`.toLowerCase();
  return /(paid|complete)/.test(v);
}

// Does this row's Status / Order-Status IMPLY a real order exists (a won /
// completed / in-progress deal), regardless of whether an order number is present?
// Used by discrepancy detection (an implied order with NO order number is flagged).
function statusImpliesOrder(statusRaw, orderStatusRaw) {
  const s = String(statusRaw || '').toLowerCase();
  if (/won\s*order/.test(s) || /orders?\s*in\s*progress/.test(s)) return true;
  return orderStatusImpliesOrder(orderStatusRaw);
}

// Normalize a raw order number to its canonical digits-only key (no leading
// zeros). MUST match controllers/finances.js#normalizeOrderNumber byte-for-byte so
// historical orders link to the same finance rows. Kept inline so this module is
// dependency-light and unit-testable in isolation.
function normalizeOrderNumber(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');
}

// ── Stage 1: CSV → clean, deduped dataset ────────────────────────────────────
//
// buildCleanDataset(csvText, opts) → {
//   clients:       [ cleanClient ],     // ONE per real company, deduped
//   orders:        [ cleanOrder ],      // historical orders linked by companyKey
//   junk:          [ junkRow ],         // the Meta-ad rows to archive
//   skipped:       [ skipRow ],         // rows with no usable company name
//   discrepancies: [ discrepancy ],     // structured review list (see below)
//   summary:       { ... },
// }
//
// cleanClient: a flat, review-ready shape (NOT a Mongoose doc) carrying exactly
// the fields the apply step writes. Identity is companyKey; akas hold collapsed
// alias names. Everything is derived from the existing, tested mapTrackerRow plus
// the new structured leadSource + alias collapsing.
function buildCleanDataset(csvText, opts = {}) {
  const year = Number(opts.year) || new Date().getUTCFullYear();
  const parsed = parseCsv(csvText);
  const { rows: rowObjs, format } = rowsToObjectsWithMeta(parsed);

  const clientsByKey = new Map(); // companyKey → cleanClient (deduped)
  const junk = [];
  const skipped = [];
  const orders = [];
  // Track every order number we MINT a historical order for, with its owners, so
  // discrepancy detection can flag a number claimed by >1 company.
  const orderNumOwners = new Map(); // normalizedNum → Set(companyKey)

  for (let i = 0; i < rowObjs.length; i++) {
    const rowObj = rowObjs[i];
    const statusRaw      = String(rowObj.status || '').trim();
    const orderStatusRaw = String(rowObj.orderStatus || '').trim();
    const orderNumRaw    = String(rowObj.orderNumber || '').trim();
    const dealValueRaw   = String(rowObj.dealValue || '').trim();
    const sourceRaw      = String(rowObj.sourceField || '').trim();
    const rawCompany     = String(rowObj.companyName || rowObj.clientName || '').trim();

    // Map the row with the existing, fully-tested mapper (handles stage/tags/
    // dates/contacts/leadSource-raw). format is forced to the detected one so the
    // keep-cold/keep-lost CRM-DB behavior applies.
    const m = mapTrackerRow(rowObj, { year, format, sourceLabel: 'Notion CRM' });

    // No usable company name → cannot key it; surface but don't load.
    if (m._skip && m._skipReason === 'no-company') {
      skipped.push({ rowIndex: i, reason: 'no-company', raw: rawCompany, status: statusRaw });
      continue;
    }

    // META-AD JUNK: skip from the real-client set; queue for archive. We DON'T
    // create a client for these and DON'T mint their orders.
    if (isMetaAdStatus(statusRaw)) {
      junk.push({
        rowIndex: i,
        companyKey: m.companyKey,
        name: m.companyName || m.clientName || rawCompany || m.companyKey,
        status: statusRaw,
        hadOrderNumber: !!orderNumRaw,
        orderNumber: orderNumRaw,
      });
      continue;
    }

    // ── A real client. Collapse alias-style names to ONE record. ──
    const { primary, akas } = parseAliasNames(rawCompany);
    const companyName = primary || rawCompany;
    const companyKey  = deriveCompanyKey(companyName, '');
    const matchKey    = deriveMatchKey(companyName, '');
    const leadSource  = mapLeadSource(sourceRaw);
    const dealValueParsed = parseMoney(dealValueRaw);
    const dealValueUnparsable = !!dealValueRaw && dealValueParsed === 0 && !/^\$?0(\.0+)?$/.test(dealValueRaw);

    const clean = {
      companyKey,
      companyName,
      clientName: m.clientName || '',
      matchKey,
      akas,
      // status-derived stage (NEVER 'customer' — earned by a real placed order)
      stage: m.stage || 'lead',
      tags: (m.tags || []).slice(),
      leadSource,
      leadSourceRaw: sourceRaw,
      dealValue: dealValueParsed,
      email: m.email || '',
      phone: m.phone || '',
      contacts: (m.contacts || []).map((c) => ({ ...c })),
      lastContact: m.lastContact || null,
      nextFollowUp: m.nextFollowUp || null,
      notes: String(rowObj.notes || '').trim(),
      engagementRaw: String(rowObj.engagement || '').trim(),
      source: 'notion',
      statusRaw,
      orderStatusRaw,
      orderNumberRaw: orderNumRaw,
      logs: (m.logs || []).map((l) => ({ ...l })),
      ambiguousDates: (m.ambiguousDates || []).slice(),
      _rowIndex: i,
      _dealValueUnparsable: dealValueUnparsable,
    };

    // DEDUP to ONE client per real company by exact companyKey. If two rows
    // collapse to the same key (e.g. an alias row and a bare row), fold the second
    // into the first rather than creating a duplicate card.
    const existing = clientsByKey.get(companyKey);
    if (existing) {
      foldDuplicateRow(existing, clean);
    } else {
      clientsByKey.set(companyKey, clean);
    }

    // HISTORICAL ORDER: a non-empty order number → one Order record, linked by
    // companyKey, status derived from Order Status, importedFrom 'notion'.
    if (orderNumRaw) {
      const normNum = normalizeOrderNumber(orderNumRaw);
      orders.push({
        orderNumber: orderNumRaw,
        normalizedOrderNumber: normNum,
        companyKey,
        companyName,
        clientName: clean.clientName,
        status: deriveOrderStatus(orderStatusRaw, statusRaw),
        paid: deriveOrderPaid(orderStatusRaw, statusRaw),
        totalValue: dealValueParsed,
        importedFrom: 'notion',
        notes: orderStatusRaw ? `Notion order status: ${orderStatusRaw}` : '',
        orderStatusRaw,
        _rowIndex: i,
      });
      if (normNum) {
        const set = orderNumOwners.get(normNum) || new Set();
        set.add(companyKey);
        orderNumOwners.set(normNum, set);
      }
    }
  }

  const clients = [...clientsByKey.values()];
  const dataset = { clients, orders, junk, skipped, orderNumOwners };
  dataset.discrepancies = detectDiscrepancies(dataset, { known: opts.knownDiscrepancies });
  dataset.summary = summarizeDataset(dataset);
  return dataset;
}

// Fold a second CSV row that collapsed onto the SAME companyKey into the first.
// Fill-blanks-only (never clobber a value the first row already had); union tags/
// akas/contacts; keep the furthest-along stage; keep the larger deal value; take
// the newer lastContact and the earliest non-null nextFollowUp.
function foldDuplicateRow(into, extra) {
  if (!into.companyName && extra.companyName) into.companyName = extra.companyName;
  if (!into.clientName && extra.clientName) into.clientName = extra.clientName;
  if (!into.email && extra.email) into.email = extra.email;
  if (!into.phone && extra.phone) into.phone = extra.phone;
  if (!into.notes && extra.notes) into.notes = extra.notes;
  if (!into.leadSource && extra.leadSource) into.leadSource = extra.leadSource;
  if ((Number(extra.dealValue) || 0) > (Number(into.dealValue) || 0)) into.dealValue = extra.dealValue;

  const tagSet = new Set(into.tags.map((t) => String(t).toLowerCase()));
  for (const t of extra.tags) { if (!tagSet.has(String(t).toLowerCase())) { into.tags.push(t); tagSet.add(String(t).toLowerCase()); } }

  const akaSet = new Set(into.akas.map((a) => deriveCompanyKey(a, '')));
  if (extra.companyName) {
    const k = deriveCompanyKey(extra.companyName, '');
    if (k && k !== into.companyKey && !akaSet.has(k)) { into.akas.push(extra.companyName); akaSet.add(k); }
  }
  for (const a of extra.akas) { const k = deriveCompanyKey(a, ''); if (k && k !== into.companyKey && !akaSet.has(k)) { into.akas.push(a); akaSet.add(k); } }

  // stage: keep furthest-along by a simple rank (won/customer terminal).
  into.stage = furthestStage(into.stage, extra.stage);
  if (extra.lastContact && (!into.lastContact || extra.lastContact > into.lastContact)) into.lastContact = extra.lastContact;
  if (extra.nextFollowUp && (!into.nextFollowUp || extra.nextFollowUp < into.nextFollowUp)) into.nextFollowUp = extra.nextFollowUp;
  for (const l of extra.logs) into.logs.push(l);
}

const STAGE_ORDER = ['lead', 'contacted', 'quoting', 'sampling', 'won', 'customer'];
function furthestStage(a, b) {
  // dormant/lost are deliberate end-states; don't let a fold drag a record OUT of
  // them, and don't promote INTO them.
  if (a === 'dormant' || a === 'lost') return a;
  if (b === 'dormant' || b === 'lost') return a;
  const ra = STAGE_ORDER.indexOf(a); const rb = STAGE_ORDER.indexOf(b);
  return rb > ra ? b : a;
}

// ── Stage 2: discrepancy detection ───────────────────────────────────────────
//
// Returns a flat, structured list the owner reviews BEFORE confirming. Each entry:
//   { kind, severity, company, companyKey, detail, ...context }
// kinds:
//   'order-implied-no-number' — Status/Order-Status implies a real order but the
//                               row has NO order number (e.g. Happy Leaf).
//   'order-number-collision'  — one order number used by >1 company.
//   'deal-value-unparsable'   — a Deal Value cell that didn't parse to a number.
//   'ambiguous-date'          — a date cell that couldn't be parsed.
//   'meta-ad-with-order'      — a Meta-ad junk row that carries an order number
//                               (so archiving it would hide an order — flag it).
function detectDiscrepancies(dataset, opts = {}) {
  const out = [];
  const { clients, junk, orderNumOwners } = dataset;
  const clientByKey = new Map(clients.map((c) => [c.companyKey, c]));

  // (a) order implied but no order number.
  for (const c of clients) {
    if (!c.orderNumberRaw && statusImpliesOrder(c.statusRaw, c.orderStatusRaw)) {
      out.push({
        kind: 'order-implied-no-number',
        severity: 'warn',
        company: c.companyName,
        companyKey: c.companyKey,
        detail: `Status "${c.statusRaw}"${c.orderStatusRaw ? ` / order status "${c.orderStatusRaw}"` : ''} implies a real order, but no order number is set. If this company has completed/in-progress orders, add the order number(s).`,
      });
    }
  }

  // (b) order number used by more than one company.
  for (const [num, owners] of orderNumOwners) {
    if (owners.size > 1) {
      out.push({
        kind: 'order-number-collision',
        severity: 'error',
        company: [...owners].join(', '),
        companyKey: '',
        orderNumber: num,
        detail: `Order number ${num} is claimed by ${owners.size} companies: ${[...owners].join(', ')}. One number should map to one order/company.`,
      });
    }
  }

  // (c) deal values that don't parse.
  for (const c of clients) {
    if (c._dealValueUnparsable) {
      out.push({
        kind: 'deal-value-unparsable',
        severity: 'warn',
        company: c.companyName,
        companyKey: c.companyKey,
        detail: `Deal Value did not parse to a number; left at 0. Review the source cell.`,
      });
    }
  }

  // (d) ambiguous dates (a date-looking cell we couldn't parse).
  for (const c of clients) {
    for (const a of (c.ambiguousDates || [])) {
      out.push({
        kind: 'ambiguous-date',
        severity: 'info',
        company: c.companyName,
        companyKey: c.companyKey,
        detail: a,
      });
    }
  }

  // (e) a Meta-ad junk row that carries an order number — archiving it would hide
  // a real order, so surface it for the owner to rescue before confirming.
  for (const j of junk) {
    if (j.hadOrderNumber) {
      out.push({
        kind: 'meta-ad-with-order',
        severity: 'warn',
        company: j.name,
        companyKey: j.companyKey,
        orderNumber: j.orderNumber,
        detail: `Row "${j.name}" is tagged "Meta Ad Conversions" (queued to archive) but carries order number ${j.orderNumber}. Confirm it's really junk before archiving.`,
      });
    }
  }

  // (f) CURATED owner-flagged discrepancies — out-of-band facts the CSV can't
  // reveal on its own (e.g. "Happy Leaf has 1 completed order" even though its
  // Status is Room Temp with no order number). These are DATA, not logic: a small
  // committed list of { companyKey, kind, severity, detail } the owner maintains.
  // Each is matched to a company in THIS dataset (so a stale entry for a company
  // no longer present is dropped) and surfaced alongside the detected ones.
  for (const k of (opts.known || [])) {
    if (!k || !k.companyKey) continue;
    const c = clientByKey.get(k.companyKey);
    if (!c) continue; // company not in the clean set this run — skip stale note
    // Don't duplicate a discrepancy the data ALREADY detected for the same company
    // + kind (e.g. an order-implied flag the rule produced on its own).
    const already = out.some((d) => d.companyKey === k.companyKey && d.kind === (k.kind || 'owner-flagged'));
    if (already) continue;
    out.push({
      kind: k.kind || 'owner-flagged',
      severity: k.severity || 'warn',
      company: c.companyName,
      companyKey: c.companyKey,
      detail: k.detail || 'Owner-flagged discrepancy.',
      ownerFlagged: true,
    });
  }

  return out;
}

// ── Stage 3: dataset + current DB state → the PLAN ───────────────────────────
//
// buildReconcilePlan(dataset, current, opts) where:
//   current = {
//     clients: [ { companyKey, matchKey, archived, source, stage, ... } ],  // ALL live Client docs (lean)
//     orders:  [ { orderNumber, companyKey, importedFrom, ... } ],          // ALL live Order docs (lean), for order dedup
//   }
// Returns the PLAN object the apply step consumes VERBATIM:
//   {
//     clientsToCreate:        [ cleanClient ],
//     clientsToUpdate:        [ { companyKey, before, mapped } ],
//     metaAdJunkToArchive:    [ { companyKey, name, alreadyArchived } ],
//     otherBadImportToArchive:[ { companyKey, name, reason } ],
//     ordersToLoad:           [ cleanOrder ],
//     ordersAlreadyPresent:   [ cleanOrder ],
//     discrepancies:          [ ... ],
//     summary:                { ... },
//   }
//
// Identity is the EXACT companyKey (never the fuzzy matchKey) so two distinct
// companies are never merged. matchKey is only used to PROPOSE look-alikes for
// the owner (proposedMerges), never to auto-merge.
function buildReconcilePlan(dataset, current = {}, opts = {}) {
  const currentClients = Array.isArray(current.clients) ? current.clients : [];
  const currentOrders = Array.isArray(current.orders) ? current.orders : [];

  // Index live clients by exact companyKey (identity) and by matchKey (proposals).
  const liveByKey = new Map();
  const liveByMatch = new Map();
  for (const d of currentClients) {
    if (d.companyKey) liveByKey.set(d.companyKey, d);
    const mk = d.matchKey || deriveMatchKey(d.companyName || '', d.clientName || '');
    if (mk) { const arr = liveByMatch.get(mk) || []; arr.push(d); liveByMatch.set(mk, arr); }
  }

  const clientsToCreate = [];
  const clientsToUpdate = [];
  const proposedMerges = [];
  const seenIncoming = new Set();

  for (const c of dataset.clients) {
    if (seenIncoming.has(c.companyKey)) continue; // dataset already deduped, belt-and-suspenders
    seenIncoming.add(c.companyKey);
    const live = liveByKey.get(c.companyKey);
    if (live) {
      clientsToUpdate.push({ companyKey: c.companyKey, name: c.companyName, mapped: c });
    } else {
      clientsToCreate.push(c);
      // Does a DIFFERENT live company share this one's fuzzy matchKey? Propose a
      // look-alike for the owner — but we still CREATE (never silently merge),
      // because the keys differ (distinct identity).
      const lookAlikes = (liveByMatch.get(c.matchKey) || []).filter((d) => d.companyKey !== c.companyKey);
      if (lookAlikes.length) {
        proposedMerges.push({
          matchKey: c.matchKey,
          incoming: { companyKey: c.companyKey, name: c.companyName },
          existing: lookAlikes.map((d) => ({ companyKey: d.companyKey, name: d.companyName || d.clientName || d.companyKey })),
        });
      }
    }
  }

  // META-AD JUNK to archive: the 111 (by companyKey). Mark whether each is already
  // live (so we know we're archiving a real record) or absent (no-op).
  const incomingRealKeys = new Set(dataset.clients.map((c) => c.companyKey));
  const metaAdJunkToArchive = [];
  for (const j of dataset.junk) {
    const live = liveByKey.get(j.companyKey);
    // Guard: if a Meta-ad row's key ALSO appears as a real client (collision),
    // do NOT archive — the real client wins. Surface via discrepancies already.
    if (incomingRealKeys.has(j.companyKey)) continue;
    metaAdJunkToArchive.push({
      companyKey: j.companyKey,
      name: j.name,
      present: !!live,
      alreadyArchived: !!(live && live.archived),
      orderNumber: j.orderNumber || '',
    });
  }

  // OTHER bad-import artifacts: today's mis-staged records. A live Client that is
  // (a) a pure import (source in the import set), (b) NOT in our clean real-client
  // set, (c) NOT already covered by the meta-ad archive list, and (d) created
  // today (the bad one-click import) — is a stray artifact to archive. We are
  // conservative: only same-day pure-import records with no orders are swept, so a
  // real older record is never touched. Cold/lost real records in our dataset are
  // KEPT by construction (they're in clientsToCreate/Update, excluded here).
  const importSources = new Set(['notion', 'field-tracker', 'crm-sheet', 'import']);
  const metaAdKeys = new Set(metaAdJunkToArchive.map((x) => x.companyKey));
  const ordersByCompany = new Set(currentOrders.map((o) => o.companyKey));
  const todayStart = opts.todayStart ? new Date(opts.todayStart) : startOfTodayUtc();
  const otherBadImportToArchive = [];
  if (opts.sweepBadImport) {
    for (const d of currentClients) {
      if (d.archived) continue;
      if (incomingRealKeys.has(d.companyKey)) continue;      // it's a real client we keep
      if (metaAdKeys.has(d.companyKey)) continue;            // already in meta-ad list
      if (!importSources.has(d.source)) continue;            // owner/order-origin records are never swept
      if (ordersByCompany.has(d.companyKey)) continue;       // anything with order history is kept
      const created = d.createdAt ? new Date(d.createdAt) : null;
      if (!created || created < todayStart) continue;        // only TODAY's stray artifacts
      otherBadImportToArchive.push({ companyKey: d.companyKey, name: d.companyName || d.clientName || d.companyKey, reason: 'bad-import' });
    }
  }

  // ORDERS to load vs already present. An order is "already present" if a live
  // order for the SAME company shares its number — compared by NORMALIZED number
  // when numeric (so "#0114" == "114"), else by the RAW string (so a non-numeric
  // number like "RUSH-A" still dedups). The apply step re-checks with the SAME
  // signature, so preview == reality and a re-run is a true no-op.
  const orderSig = (companyKey, orderNumber) => {
    const n = normalizeOrderNumber(orderNumber);
    return n ? `${companyKey}::n:${n}` : `${companyKey}::r:${String(orderNumber || '').trim().toLowerCase()}`;
  };
  const liveOrderIndex = new Set();
  for (const o of currentOrders) liveOrderIndex.add(orderSig(o.companyKey, o.orderNumber));
  const ordersToLoad = [];
  const ordersAlreadyPresent = [];
  for (const o of dataset.orders) {
    if (liveOrderIndex.has(orderSig(o.companyKey, o.orderNumber))) ordersAlreadyPresent.push(o);
    else ordersToLoad.push(o);
  }

  const plan = {
    clientsToCreate,
    clientsToUpdate,
    metaAdJunkToArchive,
    otherBadImportToArchive,
    ordersToLoad,
    ordersAlreadyPresent,
    proposedMerges,
    discrepancies: dataset.discrepancies || [],
  };
  plan.summary = summarizePlan(plan, dataset);
  return plan;
}

// Start-of-today in UTC (midnight). Used as the "created today" cutoff for the
// bad-import sweep. Kept simple/pure; the caller may pass an explicit todayStart.
function startOfTodayUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

// ── Summaries ────────────────────────────────────────────────────────────────
function summarizeDataset(dataset) {
  const byStage = {};
  for (const c of dataset.clients) byStage[c.stage] = (byStage[c.stage] || 0) + 1;
  const byLeadSource = {};
  for (const c of dataset.clients) { const k = c.leadSource || '(unset)'; byLeadSource[k] = (byLeadSource[k] || 0) + 1; }
  return {
    realClients: dataset.clients.length,
    metaAdJunk: dataset.junk.length,
    orders: dataset.orders.length,
    skipped: dataset.skipped.length,
    discrepancies: (dataset.discrepancies || []).length,
    byStage,
    byLeadSource,
  };
}

function summarizePlan(plan, dataset) {
  return {
    clientsToCreate: plan.clientsToCreate.length,
    clientsToUpdate: plan.clientsToUpdate.length,
    metaAdJunkToArchive: plan.metaAdJunkToArchive.length,
    metaAdAlreadyArchived: plan.metaAdJunkToArchive.filter((x) => x.alreadyArchived).length,
    otherBadImportToArchive: plan.otherBadImportToArchive.length,
    ordersToLoad: plan.ordersToLoad.length,
    ordersAlreadyPresent: plan.ordersAlreadyPresent.length,
    proposedMerges: plan.proposedMerges.length,
    discrepancies: plan.discrepancies.length,
    realClientsTotal: dataset ? dataset.clients.length : (plan.clientsToCreate.length + plan.clientsToUpdate.length),
    // True once a re-run would change nothing (everything created/loaded/archived).
    noOp: plan.clientsToCreate.length === 0
       && plan.ordersToLoad.length === 0
       && plan.metaAdJunkToArchive.filter((x) => x.present && !x.alreadyArchived).length === 0
       && plan.otherBadImportToArchive.length === 0,
  };
}

module.exports = {
  buildCleanDataset,
  detectDiscrepancies,
  buildReconcilePlan,
  // exported for tests / reuse
  isMetaAdStatus,
  deriveOrderStatus,
  deriveOrderPaid,
  statusImpliesOrder,
  normalizeOrderNumber,
  furthestStage,
  summarizeDataset,
  summarizePlan,
  startOfTodayUtc,
};
