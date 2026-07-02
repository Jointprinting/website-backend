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

const { fetchDispensaries, isRegion, DEFAULT_REGION, REGIONS, ADJACENT } = require('./dispensaryFinder');
const { enrichWebsite } = require('./emailEnricher');
const LeadFinderRun = require('../models/LeadFinderRun');
const Client = require('../models/Client');
const { buildMappedRows, applyMappedRow } = require('../controllers/crm');

const DEFAULT_MAX_ENRICH = parseInt(process.env.LEAD_FINDER_MAX_ENRICH || '80', 10);
const ENRICH_CONCURRENCY = parseInt(process.env.LEAD_FINDER_CONCURRENCY || '4', 10);
const FINDER_TAG = 'dispensary';

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
async function discoverRegion(regionId, { maxEnrich = DEFAULT_MAX_ENRICH } = {}) {
  const { region, label, candidates } = await fetchDispensaries(regionId);

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

  return { region, label, found: candidates.length, candidates: withEmailCandidates, withEmail, enriched };
}

// Full run: discover → (live) import → tag → record. `dryRun` skips all writes
// but returns the same shape so the UI preview matches reality.
async function runFinder({ region = DEFAULT_REGION, dryRun = false, maxEnrich } = {}) {
  const regionId = isRegion(region) ? region : DEFAULT_REGION;
  const disc = await discoverRegion(regionId, { maxEnrich });

  // Only import candidates that carry an email — an un-emailable lead can't be
  // cold-contacted, so it would just clutter the CRM. (They're still counted in
  // `found` so the owner sees total coverage.)
  const importable = disc.candidates.filter((c) => c.email);
  const rows = importable.map((c) => ({
    companyName: c.name,
    email: c.email,
    phone: c.phone || '',
    address: c.address || '',
    source: 'Cold Outreach', // → structured leadSource, so every lead is filterable
  }));

  if (dryRun) {
    return {
      dryRun: true, region: regionId, label: disc.label,
      found: disc.found, withEmail: disc.withEmail, enriched: disc.enriched,
      willImport: rows.length,
    };
  }

  // Reuse the CRM importer's exact merge policy (fill-blanks, dedupe, no downgrade).
  const mapped = buildMappedRows({ rows });
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

  // Tag every imported company so the whole finder-sourced set is one CRM filter.
  if (touchedKeys.length) {
    await Client.updateMany({ companyKey: { $in: touchedKeys } }, { $addToSet: { tags: FINDER_TAG } })
      .catch(() => {});
  }

  const result = {
    region: regionId, label: disc.label,
    found: disc.found, withEmail: disc.withEmail, enriched: disc.enriched,
    created, updated, skipped,
  };
  await LeadFinderRun.create({ ...result, dryRun: false }).catch(() => {});
  return result;
}

// Status for the Studio: recent runs + per-region last-swept + suggested next
// region to expand into once the current one is worked through.
async function finderStatus() {
  const runs = await LeadFinderRun.find({ dryRun: false }).sort({ createdAt: -1 }).limit(10).lean();
  const lastByRegion = {};
  for (const r of runs) if (!lastByRegion[r.region]) lastByRegion[r.region] = r;
  return {
    regions: Object.entries(REGIONS).map(([id, r]) => ({
      id, label: r.label, last: lastByRegion[id] || null,
    })),
    adjacency: ADJACENT,
    recentRuns: runs,
  };
}

module.exports = { runFinder, discoverRegion, finderStatus, pool };
