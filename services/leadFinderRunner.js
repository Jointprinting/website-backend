// services/leadFinderRunner.js
//
// Orchestrates the FREE dispensary lead machine, region by region:
//   discover (OSM/Overpass) → enrich missing emails (scrape the shop's site) →
//   import into the CRM as 'Cold Outreach' leads → tag them → record the run.
//
// Reuses the CRM's own, battle-tested import path (buildMappedRows +
// applyMappedRow) so these leads behave EXACTLY like a manual CSV import:
// fill-blanks-only merge, dedupe by companyKey, never downgrade a record the
// owner already advanced. Nothing here sends email — that's the outreach engine,
// which already refuses to enroll real customers, so clients stay protected.
//
// Cost: $0. OSM is free/keyless; enrichment only fetches pages the shops publish
// themselves. A per-run scrape cap keeps a sweep bounded and polite.

const { fetchDispensaries, isRegion, DEFAULT_REGION, REGIONS, NATIONAL_ROLLOUT, FINDER_VERSION } = require('./dispensaryFinder');
const { getVertical, verticalPoolFilter, verticalRunMatch, frontierStateKey, otherVerticalTags, DEFAULT_VERTICAL_ID } = require('./leadVerticals');
const LeadFinderState = require('../models/LeadFinderState');
const { cityFromAddress } = require('./outreachEngine');
const { enrichWebsite } = require('./emailEnricher');
const { verifyDomainsMx, partitionDeliverable, emailDomain } = require('./emailVerify');
const LeadFinderRun = require('../models/LeadFinderRun');
const Client = require('../models/Client');
const Order = require('../models/Order');
const OutreachEnrollment = require('../models/OutreachEnrollment');
const { PLACED_STATUSES } = require('../models/Order');
const { buildMappedRows, applyMappedRow } = require('../controllers/crm');

const DEFAULT_MAX_ENRICH = parseInt(process.env.LEAD_FINDER_MAX_ENRICH || '80', 10);
const ENRICH_CONCURRENCY = parseInt(process.env.LEAD_FINDER_CONCURRENCY || '4', 10);

// Run `worker` over `items` with at most `concurrency` in flight. Resolves to the
// results array (worker must not throw — enrichWebsite already swallows).
async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// Discover + enrich a region into import-ready rows. Returns
// { region, label, found, candidates, withEmail, enriched }. No DB writes — the
// caller decides dry-run vs live.
async function discoverRegion(regionId, { maxEnrich = DEFAULT_MAX_ENRICH, vertical } = {}) {
  const { region, label, candidates } = await fetchDispensaries(regionId, { vertical });

  // Split: already have an email (free, from OSM) vs. need a scrape (have a
  // website but no email). No website + no email → unreachable, still counted.
  const needScrape = candidates.filter((c) => !c.email && c.website).slice(0, Math.max(0, maxEnrich));
  let enriched = 0;
  const scraped = await pool(needScrape, ENRICH_CONCURRENCY, async (c) => {
    const email = await enrichWebsite(c.website);
    return { website: c.website, email };
  });
  const emailByWebsite = new Map();
  for (const r of scraped) if (r && r.email) { emailByWebsite.set(r.website, r.email); enriched += 1; }

  const withEmailCandidates = candidates.map((c) => {
    const email = c.email || emailByWebsite.get(c.website) || '';
    return { ...c, email };
  });
  const withEmail = withEmailCandidates.filter((c) => c.email).length;

  // Verify deliverability (free MX/A check) so scraped-but-dead addresses never
  // enter the CRM and bounce. Verify only the ones that HAVE an email; the rest
  // stay as un-emailable coverage. Deduped by domain, so it's a handful of DNS
  // lookups. Disable with LEAD_FINDER_VERIFY_MX=off.
  const withEmailOnly = withEmailCandidates.filter((c) => c.email);
  let candidatesOut = withEmailCandidates;
  let verified = withEmail;
  if (process.env.LEAD_FINDER_VERIFY_MX !== 'off' && withEmailOnly.length) {
    const mxMap = await verifyDomainsMx(withEmailOnly.map((c) => emailDomain(c.email)));
    const { good } = partitionDeliverable(withEmailOnly, mxMap);
    const goodSet = new Set(good.map((c) => c.osmId || `${c.name}|${c.email}`));
    // Blank the email on candidates whose domain can't receive mail (keep the row
    // for coverage counts, just don't import an undeliverable address).
    candidatesOut = withEmailCandidates.map((c) => {
      if (!c.email) return c;
      const id = c.osmId || `${c.name}|${c.email}`;
      return goodSet.has(id) ? c : { ...c, email: '', undeliverable: true };
    });
    verified = good.length;
  }

  return {
    region, label, found: candidates.length, candidates: candidatesOut,
    withEmail, enriched, verified,
  };
}

// City → key-suffix slug ("Egg Harbor Township" → 'eggharbortownship'). Same
// normalization deriveCompanyKey applies to names, so suffixed keys look native.
const citySlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// deriveCompanyKey is NAME-only, so "Green Leaf" in Newark and "Green Leaf" in
// Denver collapse into ONE Client — the second find silently merges into (and
// cross-wires the contact data of) the first. Orders key on the shared
// deriveCompanyKey, so that helper must not change; instead the FINDER
// disambiguates ITS OWN import keys: when a client already exists under the
// bare key with a provably DIFFERENT city, the new lead imports under
// `${baseKey}-${cityslug}`. Same city → it IS the same shop re-found (keep the
// bare key so re-sweeps keep deduping onto the same record). Either city
// unknown → can't prove a conflict, keep the bare key (fill-blanks merge is the
// safe default; a wrong split is worse than a conservative merge). The suffix
// derives from the LEAD's own city, so every future re-find of the Denver shop
// lands on the same suffixed record. Pure + unit-tested.
function disambiguateKey(baseKey, newCity, existingCity) {
  const a = citySlug(newCity);
  const b = citySlug(existingCity);
  if (!a || !b || a === b) return baseKey;
  return `${baseKey}-${a}`;
}

// Decide which discovered candidates become CRM leads. This is a MAIL-MERGE
// engine — an email is required (no inbox, no cold-email lead, nothing to send).
// Chains/MSOs are dropped (unless disabled — corporate handles merch, not the
// store); emails are de-duped within the batch so one shared inbox is queued
// once. Pure + unit-tested.
function selectImportable(candidates, { skipChains = true } = {}) {
  const seenEmail = new Set();
  return (candidates || []).filter((c) => {
    if (!c || !c.email) return false;          // mail merge → email required
    if (skipChains && c.chain) return false;
    if (seenEmail.has(c.email)) return false;  // same inbox already queued this run
    seenEmail.add(c.email);
    return true;
  });
}

// Full run: discover → (live) import → tag → record. `dryRun` skips all writes
// but returns the same shape so the UI preview matches reality. `vertical`
// retargets the whole run to another business type (default: dispensaries) — it
// discovers that vertical's leads, stamps them with that vertical's CRM tag, and
// records the run under that vertical + its own finder version.
async function runFinder({ region = DEFAULT_REGION, dryRun = false, maxEnrich, vertical: verticalId = DEFAULT_VERTICAL_ID } = {}) {
  const vertical = getVertical(verticalId);
  const regionId = isRegion(region) ? region : DEFAULT_REGION;
  const disc = await discoverRegion(regionId, { maxEnrich, vertical });

  // Mail-merge: only shops with a deliverable email become leads (an inbox is
  // what we send to). Skip big chains / MSOs (LEAD_FINDER_SKIP_CHAINS=off to
  // include them) — corporate handles merch, not the store — and dedupe by EMAIL
  // within the batch so one shared inbox is never queued twice.
  const skipChains = process.env.LEAD_FINDER_SKIP_CHAINS !== 'off';
  const skippedChains = skipChains ? disc.candidates.filter((c) => c.email && c.chain).length : 0;
  const importable = selectImportable(disc.candidates, { skipChains });
  const rows = importable.map((c) => ({
    companyName: c.name,
    email: c.email,
    phone: c.phone || '',
    address: c.address || '',
    source: 'Cold Outreach', // → structured leadSource, so every lead is filterable
  }));

  if (dryRun) {
    return {
      dryRun: true, region: regionId, vertical: vertical.id, label: disc.label,
      found: disc.found, withEmail: disc.withEmail, enriched: disc.enriched,
      verified: disc.verified, skippedChains, willImport: rows.length,
    };
  }

  // Reuse the CRM importer's exact merge policy (fill-blanks, dedupe, no downgrade).
  const mapped = buildMappedRows({ rows });

  // Same-name/different-city collision guard: one batched lookup of the batch's
  // bare keys, then re-key any lead whose bare key is already held by a client
  // in ANOTHER city (see disambiguateKey). Done between mapping and applying so
  // applyMappedRow's find-by-companyKey lands on the right record — the merge
  // policy itself stays untouched.
  const bareKeys = [...new Set((mapped || []).filter((m) => m && !m._skip && m.companyKey).map((m) => m.companyKey))];
  const existingClients = bareKeys.length
    ? await Client.find({ companyKey: { $in: bareKeys } }).select('companyKey address area').lean()
    : [];
  const existingByKey = new Map(existingClients.map((c) => [c.companyKey, c]));
  for (const m of mapped || []) {
    if (!m || m._skip || !m.companyKey) continue;
    const ex = existingByKey.get(m.companyKey);
    if (!ex) continue;
    const key = disambiguateKey(m.companyKey, cityFromAddress(m.address), cityFromAddress(ex.address || ex.area));
    if (key !== m.companyKey) {
      m.companyKey = key;
      m.rowIdentity = key; // the log-dedup identity follows the record it lands on
    }
  }
  // WITHIN-batch collisions too: a whole state imports as one batch, so "Green
  // Leaf" Newark and "Green Leaf" Trenton often arrive together with no existing
  // client to compare against — the second would silently fill-blanks-merge into
  // the first. First occurrence keeps its key; a later same-key row in a
  // provably different city gets the suffix.
  const firstCityByKey = new Map();
  for (const m of mapped || []) {
    if (!m || m._skip || !m.companyKey) continue;
    const base = m.companyKey;
    const city = cityFromAddress(m.address);
    if (!firstCityByKey.has(base)) { firstCityByKey.set(base, city); continue; }
    const key = disambiguateKey(base, city, firstCityByKey.get(base));
    if (key !== base) {
      m.companyKey = key;
      m.rowIdentity = key;
    }
  }

  let created = 0, updated = 0, skipped = 0;
  const touchedKeys = [];
  for (const m of mapped || []) {
    if (m._skip || !m.companyKey) { skipped += 1; continue; }
    try {
      const { outcome } = await applyMappedRow(m, {});
      if (outcome === 'created') created += 1;
      else if (outcome === 'updated') updated += 1;
      touchedKeys.push(m.companyKey);
    } catch (_e) {
      skipped += 1;
    }
  }

  // Tag every imported company with the VERTICAL's tag so its cold pool is a
  // single CRM filter — and so enrollment only ever draws that vertical's leads
  // into that vertical's campaigns (a brewery campaign never emails a dispensary).
  // FIRST-TOUCH WINS: never claim a company already owned by ANOTHER vertical, so
  // a lead found under two verticals can't migrate pools or carry two vertical
  // tags (which would strand it, or — via the dispensary catch-all — pitch it the
  // wrong vertical). Whoever finds it first keeps it.
  if (touchedKeys.length) {
    const claimed = otherVerticalTags(vertical.id);
    await Client.updateMany(
      { companyKey: { $in: touchedKeys }, ...(claimed.length ? { tags: { $nin: claimed } } : {}) },
      { $addToSet: { tags: vertical.tag } },
    ).catch(() => {});
  }

  const result = {
    region: regionId, vertical: vertical.id, label: disc.label,
    found: disc.found, withEmail: disc.withEmail, enriched: disc.enriched,
    verified: disc.verified, skippedChains, created, updated, skipped,
    finderVersion: vertical.finderVersion,
  };
  await LeadFinderRun.create({ ...result, dryRun: false }).catch(() => {});
  return result;
}

// How many COLD leads are sitting ready to enroll right now — the finder's
// "queue depth". A lead counts if it's never been personally contacted
// (lastContact null), has an email, isn't opted out/archived, isn't a customer
// by order reality, and isn't already enrolled in a campaign. The auto-pilot
// refills whenever this drops below the watermark, so supply tracks sending.
async function countAvailableColdLeads({ vertical } = {}) {
  // Scope to the vertical's own pool when asked (the scheduler gates each
  // vertical's refill on ITS supply, so a full dispensary pool can't starve a new
  // brewery campaign). No vertical → the whole cold pool (the general status number).
  const poolFilter = vertical ? verticalPoolFilter(vertical) : {};
  const clients = await Client.find({
    // Mirror the ACTUAL enroll selector (autoFillCampaign): only leads at stage
    // lead/contacted enroll, so counting advanced/terminal stages here would
    // over-report "available", keep the refill gate satisfied, and silently starve
    // the drip. (Suppression is still applied at enroll; this fixes the big skew.)
    archived: { $ne: true }, doNotEmail: { $ne: true }, lastContact: null,
    stage: { $in: ['lead', 'contacted'] }, ...poolFilter,
  }).select('companyKey email contacts').lean();
  const cold = clients.filter((c) =>
    (c.email && String(c.email).trim()) ||
    (Array.isArray(c.contacts) && c.contacts.some((x) => x && x.email && String(x.email).trim())));
  if (!cold.length) return 0;
  const keys = cold.map((c) => c.companyKey);
  const [enrolledRows, placedRows] = await Promise.all([
    OutreachEnrollment.find({ companyKey: { $in: keys } }).select('companyKey').lean(),
    Order.find({ companyKey: { $in: keys }, status: { $in: PLACED_STATUSES } }).select('companyKey').lean(),
  ]);
  const excluded = new Set([
    ...enrolledRows.map((e) => e.companyKey),
    ...placedRows.map((o) => o.companyKey),
  ]);
  return cold.filter((c) => !excluded.has(c.companyKey)).length;
}

// Which already-swept states were last covered by an OLDER finder version. The
// always-on engine re-milks these in the background (bounded per run), so when
// the finder itself improves — a wider net, better scraping, email-optional
// import — every state it already touched gets upgraded automatically, with no
// manual "re-sweep from the start". Oldest-swept first (fairest catch-up order).
// NEVER includes un-swept states — expanding to those is the frontier's job, on
// the queue-low path. `limit` caps the batch for politeness. Pure read.
async function staleRegions(currentVersion = FINDER_VERSION, limit = 0, vertical = DEFAULT_VERTICAL_ID) {
  // Error rows (a sweep that THREW — see leadFinderScheduler.noteRegionFailure)
  // are excluded from the version bookkeeping: they carry finderVersion 0, so
  // counting them would (a) let one failed attempt mask a region's real, older
  // coverage version, and (b) make the healthy-pool upgrade path retry a broken
  // region forever — retries of FAILURES are the frontier ledger's job, which is
  // capped. This aggregation reads "the last sweep that actually produced data".
  // ($in with null also matches legacy rows missing the field.)
  const byRegion = await LeadFinderRun.aggregate([
    { $match: { dryRun: false, error: { $in: ['', null] }, ...verticalRunMatch(vertical) } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$region', v: { $first: '$finderVersion' }, at: { $first: '$createdAt' } } },
  ]);
  const stale = byRegion
    .filter((g) => g && g._id && isRegion(g._id) && (Number(g.v) || 0) < currentVersion)
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))
    .map((g) => g._id);
  return limit > 0 ? stale.slice(0, limit) : stale;
}

// Status for the Studio: the auto-pilot frontier + recent runs + per-region
// last-swept, in national-rollout order (so the UI can show the frontier line).
async function finderStatus({ vertical } = {}) {
  const v = getVertical(vertical);
  const runMatch = verticalRunMatch(v.id);
  const [byRegion, byRegionError, runs, state, available] = await Promise.all([
    // The LATEST real run per region — NOT the latest 10 overall. One sweep
    // writes up to MAX_REGIONS_PER_RUN rows, so a flat limit(10) forgets states
    // once the engine has covered more than ~1.7 sweeps, reverting their coverage
    // tiles to "not reached yet" and shuffling the swept count. Group per region
    // so the map shows every state the engine has actually touched. Scoped to this
    // vertical's runs (dispensary also matches legacy rows — see verticalRunMatch).
    // Error rows are kept OUT of the coverage stats (a failed sweep found
    // nothing — zeroing a state's real numbers with it would lie the other way)…
    LeadFinderRun.aggregate([
      { $match: { dryRun: false, error: { $in: ['', null] }, ...runMatch } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$region', last: { $first: '$$ROOT' } } },
    ]),
    // …and surfaced separately: the latest FAILED attempt per region, so the map
    // can honestly distinguish "we tried and it broke" (lastError below) from
    // "the frontier never reached it" (no run rows at all).
    LeadFinderRun.aggregate([
      { $match: { dryRun: false, error: { $nin: ['', null] }, ...runMatch } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$region', last: { $first: '$$ROOT' } } },
    ]),
    LeadFinderRun.find({ dryRun: false, ...runMatch }).sort({ createdAt: -1 }).limit(10).lean(), // recentRuns feed
    LeadFinderState.findOne({ key: frontierStateKey(v.id) }).lean(),
    countAvailableColdLeads({ vertical: v.id }),
  ]);
  const lastByRegion = {};
  for (const g of byRegion) if (g && g._id) lastByRegion[g._id] = g.last;
  const lastErrorByRegion = {};
  for (const g of byRegionError) if (g && g._id) lastErrorByRegion[g._id] = g.last;
  const activeRegion = (state && state.activeRegion) || DEFAULT_REGION;
  let staleCount = 0;
  const regions = NATIONAL_ROLLOUT
    .filter((id) => REGIONS[id])
    .map((id) => {
      const last = lastByRegion[id] || null;
      const lastSweptAt = last ? last.createdAt : null;
      // "Just swept" = a real sweep within the last 6h (one refill cycle), so
      // the UI can grey the manual button and tell the owner it's done for now.
      const recentlySwept = lastSweptAt ? (Date.now() - new Date(lastSweptAt).getTime() < 6 * 3600 * 1000) : false;
      // Swept, but by an older finder — the engine will re-milk it automatically.
      const stale = !!last && (Number(last.finderVersion) || 0) < v.finderVersion;
      if (stale) staleCount += 1;
      // Honesty about failures: a FAILED attempt NEWER than the last clean sweep
      // (or with no clean sweep at all) is surfaced, so "swept: 0 leads" and
      // "the sweep itself broke" and "never reached" read as three different
      // things on the coverage map. The retry ledger (leadFinderScheduler) will
      // re-attempt it; this is just the honest label meanwhile.
      const lastErr = lastErrorByRegion[id] || null;
      const errIsCurrent = !!lastErr && (!lastSweptAt || new Date(lastErr.createdAt) > new Date(lastSweptAt));
      return {
        id, label: REGIONS[id].label, last,
        lastSweptAt,
        lastFound: last ? (last.found || 0) : 0,
        lastNew: last ? (last.created || 0) : 0,
        finderVersion: last ? (Number(last.finderVersion) || 0) : null,
        stale,
        recentlySwept,
        lastError: errIsCurrent ? (lastErr.error || 'sweep failed') : '',
        lastErrorAt: errIsCurrent ? lastErr.createdAt : null,
      };
    });
  return {
    vertical: v.id,
    verticalLabel: v.label,
    frontier: {
      activeRegion,
      activeLabel: REGIONS[activeRegion] ? REGIONS[activeRegion].label : activeRegion,
      // The lead engine is always on now (the toggle is gone); reported for
      // any older client still reading it.
      autoAdvance: true,
      availableColdLeads: available,
      dryStreak: (state && state.dryStreak) || 0,
      lastRunAt: state ? state.lastRunAt : null,
      lastResult: state ? state.lastResult : '',
    },
    // Current finder logic version + how many swept states are still on an older
    // one (i.e. queued for an automatic background upgrade). Lets the UI say
    // "sharpening coverage" instead of asking the owner to re-sweep.
    finderVersion: v.finderVersion,
    staleCount,
    regions,
    recentRuns: runs,
  };
}

module.exports = {
  runFinder, discoverRegion, finderStatus, countAvailableColdLeads, staleRegions, pool,
  selectImportable, disambiguateKey, // pure — unit-tested
};
