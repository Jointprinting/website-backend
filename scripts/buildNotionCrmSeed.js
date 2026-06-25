#!/usr/bin/env node
// scripts/buildNotionCrmSeed.js
//
// ONE-TIME parse of the owner's staged Notion CRM export into a committed,
// reviewable clean seed at data/notionCrmSeed.json. This is the artifact the
// reconcile endpoints load (so production never needs the raw CSV, and the data
// is git-reviewable before the owner runs anything).
//
// Usage:
//   node scripts/buildNotionCrmSeed.js <path/to/notion_crm_export.csv>
//   NOTION_CSV=<path> node scripts/buildNotionCrmSeed.js
//
// Pass the staged export path (argv or the NOTION_CSV env var). Re-running
// regenerates the seed deterministically. It NEVER writes to any database — it
// only emits the committed JSON seed.

const fs = require('fs');
const path = require('path');
const { buildCleanDataset } = require('../services/crmReconcile');

const OUT = path.join(__dirname, '..', 'data', 'notionCrmSeed.json');
const KNOWN = path.join(__dirname, '..', 'data', 'reconcileKnownDiscrepancies.json');

function main() {
  const csvPath = process.argv[2] || process.env.NOTION_CSV;
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error(`CSV not found${csvPath ? ` at ${csvPath}` : ''}.`);
    console.error('Pass the export path: node scripts/buildNotionCrmSeed.js <path-to-csv>');
    process.exit(1);
  }
  const csv = fs.readFileSync(csvPath, 'utf8');

  let known = [];
  try { known = JSON.parse(fs.readFileSync(KNOWN, 'utf8')); } catch (_) { known = []; }

  // Year: the export uses ISO dates, so the assumed-year only matters for bare
  // M/D cells. Use the current year (matches the importer's default).
  const dataset = buildCleanDataset(csv, { year: new Date().getUTCFullYear(), knownDiscrepancies: known });

  // Strip the internal-only bookkeeping fields from the committed seed so it's a
  // clean review artifact (the reconcile recomputes derived state at apply time).
  const seed = {
    generatedAt: new Date().toISOString(),
    sourceFile: path.basename(csvPath),
    summary: dataset.summary,
    clients: dataset.clients.map(stripClient),
    orders: dataset.orders.map(stripOrder),
    metaAdJunk: dataset.junk.map((j) => ({ companyKey: j.companyKey, name: j.name, orderNumber: j.orderNumber || '' })),
    skipped: dataset.skipped,
    discrepancies: dataset.discrepancies,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`Wrote ${OUT}`);
  console.log(`  real clients: ${seed.clients.length}`);
  console.log(`  meta-ad junk: ${seed.metaAdJunk.length}`);
  console.log(`  orders:       ${seed.orders.length}`);
  console.log(`  discrepancies:${seed.discrepancies.length}`);
  console.log(`  by stage:     ${JSON.stringify(seed.summary.byStage)}`);
}

function stripClient(c) {
  return {
    companyKey: c.companyKey,
    companyName: c.companyName,
    clientName: c.clientName,
    matchKey: c.matchKey,
    akas: c.akas,
    stage: c.stage,
    tags: c.tags,
    leadSource: c.leadSource,
    dealValue: c.dealValue,
    email: c.email,
    phone: c.phone,
    contacts: c.contacts,
    lastContact: c.lastContact ? c.lastContact.toISOString() : null,
    nextFollowUp: c.nextFollowUp ? c.nextFollowUp.toISOString() : null,
    notes: c.notes,
    source: c.source,
    statusRaw: c.statusRaw,
    orderStatusRaw: c.orderStatusRaw,
    orderNumberRaw: c.orderNumberRaw,
    logs: c.logs,
  };
}

function stripOrder(o) {
  return {
    orderNumber: o.orderNumber,
    normalizedOrderNumber: o.normalizedOrderNumber,
    companyKey: o.companyKey,
    companyName: o.companyName,
    clientName: o.clientName,
    status: o.status,
    paid: o.paid,
    totalValue: o.totalValue,
    importedFrom: o.importedFrom,
    notes: o.notes,
    orderStatusRaw: o.orderStatusRaw,
  };
}

main();
