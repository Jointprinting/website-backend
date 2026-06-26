// scripts/buildVendorPoSeed.js
//
// Builds data/vendorPoSeed.json — the cleaned PRINTER/VENDOR + PURCHASE-ORDER
// dataset the owner's vendor/PO reconcile (controllers/vendorRebuild) loads. The
// source of truth is the owner's real Google Drive "POs" folder: ONE SUBFOLDER PER
// PRINTER, each holding that printer's PO documents. The PO records below were read
// out of those Drive docs (extracted text), one record per real PO, with templates
// and blank/placeholder docs excluded (and flagged). Vendor spend + the orders each
// printer printed are cross-referenced against the verified finance ledger (the
// Printer/Blank COGS rows), so the figures reconcile with the books.
//
// This is a DETERMINISTIC builder over committed data (mirrors buildFinanceSeed.js /
// buildNotionCrmSeed.js): no network, no Drive call at build time — the Drive read
// already happened and its result is encoded here as DRIVE_POS. Re-running it just
// regenerates the JSON. Run:  node scripts/buildVendorPoSeed.js
//
// The 16 printer folders (canonical vendor name == folder title) and their Drive
// folder ids are recorded in VENDOR_FOLDERS so the provenance is auditable.

const fs = require('fs');
const path = require('path');
const { canonicalVendorName, VENDOR_FOLDERS } = require('../services/vendorRebuild');

const LEDGER_PATH = process.env.LEDGER_PATH
  || path.join('/tmp/claude-0/-home-user/a1b0637f-6239-5ee4-93e7-212b5511988a/scratchpad', 'finance_ledger.json');
const OUT_BACKEND = path.join(__dirname, '..', 'data', 'vendorPoSeed.json');
const OUT_SCRATCH = process.env.SCRATCH_OUT
  || path.join('/tmp/claude-0/-home-user/a1b0637f-6239-5ee4-93e7-212b5511988a/scratchpad', 'vendor_po_seed.json');

// ── The PO records read from the owner's Drive "POs" folder ───────────────────
// One object per Drive document. Fields:
//   vendor       canonical printer (the folder it lives in)
//   poNumber     as written in the doc ("#008", "#001B", "#0001 Reprint", …)
//   date         ISO yyyy-mm-dd when the doc carried a real date, else null
//   client       the ship-to / merch line (the customer the print was for)
//   grandTotal   the doc's Grand/Total Price (number), or null when blank
//   sourceFileId the Drive file id (provenance + the card's "source" link)
//   sourceTitle  the Drive doc title (for the audit list)
//   flags        array of review flags (template-titled / no-total / dup-number /
//                not-a-po / image-only / format-variant …) — empty for a clean PO
//   skip         true → NOT loaded as a PO (template or not-a-PO); still recorded
//                in the audit list so nothing is silently dropped
const DRIVE_POS = [
  // ── Heritage Screen Printing ────────────────────────────────────────────────
  { vendor: 'Heritage Screen Printing', poNumber: '#001', date: '2025-05-15', client: 'Sauce Me A Fry Merch', grandTotal: 736.45, sourceFileId: '1IRURd87LskPXocOpa_V6tX0oJ63SEbDhTupnDqAXzsc', sourceTitle: 'Heritage PO - #001' },
  { vendor: 'Heritage Screen Printing', poNumber: '#002', date: '2025-07-01', client: 'The CannaBoss Lady Merch', grandTotal: 875.50, sourceFileId: '1uWwQsG8R0D37GD3eWH2EJZYVPqTHjvmn2GNdkwF8M0s', sourceTitle: 'Heritage PO - #002' },
  { vendor: 'Heritage Screen Printing', poNumber: '#003', date: '2025-07-09', client: 'OS NYC Merch', grandTotal: 324.45, sourceFileId: '16CzdmizqnyjVEpVGZSOQBL9N4AFB1xzEvLXqzorhs80', sourceTitle: 'Heritage PO - #003' },
  { vendor: 'Heritage Screen Printing', poNumber: '#004', date: '2026-04-21', client: 'Joint Printing Merch (pickup)', grandTotal: 80, sourceFileId: '1F6stTm0KcVHe7IcCMEqUplVhqCqhF3lPkAXCu36sWD4', sourceTitle: 'Heritage PO - #004', flags: ['no-grand-total-line'] },
  { vendor: 'Heritage Screen Printing', poNumber: '#0004', date: '2025-09-19', client: 'Human AF Merch', grandTotal: 255.85, sourceFileId: '1uDZSQHgtE-9kqTnu63IfhWhpJaPiTDsPzlfwBOjYS9k', sourceTitle: 'Heritage PO - Human AF', flags: ['dup-po-number'] },
  { vendor: 'Heritage Screen Printing', poNumber: '#005', date: '2026-05-04', client: 'Sauce Me A Fry Merch', grandTotal: 177.60, sourceFileId: '1rCx-Zy0YAFkJaKnZoCUHDpXeJzRwpJ27Y2Tm5-Jn63o', sourceTitle: 'Heritage PO - #005' },
  { vendor: 'Heritage Screen Printing', poNumber: '#0005', date: null, client: 'M4JI Merch', grandTotal: 307.50, sourceFileId: '166Ikw1h6qWB19M6gH1f_KnXlxpr1mml8S9dOapvHfJY', sourceTitle: 'Heritage PO - M4JI', flags: ['dup-po-number', 'no-date'] },
  { vendor: 'Heritage Screen Printing', poNumber: '#006', date: '2026-05-22', client: 'Bleu Leaf Dispensary Merch', grandTotal: 349.50, sourceFileId: '14ttFsszzCjwjhyU7F_3cwpkC2OF1Mb60hYcatksrUi4', sourceTitle: 'Heritage PO - #006' },
  { vendor: 'Heritage Screen Printing', poNumber: '#007', date: '2026-06-12', client: 'Plantabis Merch', grandTotal: 60, sourceFileId: '1awqqXDQ2zIotD9xnRSLCTZpLHx81jYHbvGY977odMqU', sourceTitle: 'Heritage PO - #007' },
  { vendor: 'Heritage Screen Printing', poNumber: '#008', date: '2026-06-17', client: 'Coastline Dispensary Merch', grandTotal: 189.92, sourceFileId: '1XqwUtnoJkQTi09mpe1fpaO3elrskdPr95O1UJ-QmoLU', sourceTitle: 'Heritage PO - #008' },
  { vendor: 'Heritage Screen Printing', poNumber: '#0000', date: null, client: '', grandTotal: null, sourceFileId: '1ROeLM7ABroeslf6wvajxI_-VG2p5DMkhzYAGRa0rWrY', sourceTitle: 'Heritage PO - Template', skip: true, flags: ['template'] },

  // ── Cannabis Promotions ─────────────────────────────────────────────────────
  { vendor: 'Cannabis Promotions', poNumber: '#001', date: '2025-02-25', client: 'The CannaBoss Lady Merch', grandTotal: 489.62, sourceFileId: '1awO99n0wj-2ZOO8AAfHIfUplWTk8OzS2et8eG_oQMSc', sourceTitle: 'Cannabis Promotions PO - #001' },
  { vendor: 'Cannabis Promotions', poNumber: '#002', date: '2025-03-27', client: "Earl & Tom's Dispensary Merch", grandTotal: 347.93, sourceFileId: '1PjIEMMWVK1wjjc2Ur7neKVVDuDJiVVLdFGDQOYp4XWc', sourceTitle: 'Cannabis Promotions PO - #002' },
  { vendor: 'Cannabis Promotions', poNumber: '#003', date: '2025-07-01', client: 'The CannaBoss Lady Merch', grandTotal: 834.62, sourceFileId: '1qnw5TlR1eFyVtjoQJEg1iXwoQHkeNMPBZfH5qEYH0_g', sourceTitle: 'Cannabis Promotions PO - #003' },
  { vendor: 'Cannabis Promotions', poNumber: '#004', date: null, client: 'Mad Martian Farms Merch', grandTotal: 2239, sourceFileId: '17PO-OdDwmmkw0goc5AV3xLPwBrwXfqwbtB9KpnQWckA', sourceTitle: 'Cannabis Promotions PO - #004', flags: ['no-date'] },
  { vendor: 'Cannabis Promotions', poNumber: '#005', date: '2026-03-20', client: 'Swan Rose Holdings Merch', grandTotal: null, sourceFileId: '1M-dGL56XVHYd5Fgj3uKcTvFOjZwewvgMhJHodvGLZls', sourceTitle: 'Cannabis Promotions x Joint Printing PO #005', flags: ['no-total'] },
  { vendor: 'Cannabis Promotions', poNumber: '#006', date: '2026-06-12', client: 'Plantabis Merch', grandTotal: 752, sourceFileId: '1MCN6f_ESFhldyC_9sdz0RIW5YmG08hrUfiuxmjjzaoQ', sourceTitle: 'Cannabis Promotions x Joint Printing PO #006' },

  // ── Worldwide Promotion Inc (PDF invoice, not the standard PO format) ─────────
  { vendor: 'Worldwide Promotion Inc', poNumber: 'PWKVG2605231', date: '2026-05-23', client: 'Bleu Leaf Dispensary', grandTotal: 94.50, sourceFileId: '1saDf_Xq9pSvx9DZ1Ex37wUJAYrvHL2Z7', sourceTitle: 'PWKVG2605231.pdf', flags: ['vendor-invoice-format'] },

  // ── Ace Screen Printing ─────────────────────────────────────────────────────
  { vendor: 'Ace Screen Printing', poNumber: '#0001', date: '2025-02-26', client: 'Point in Time Studios Merch', grandTotal: 240, sourceFileId: '1omzRwE9tudW1shCEYrORL2sU3qEsOOelwd1363l-zoc', sourceTitle: 'Ace PO - Point in Time Studios' },
  { vendor: 'Ace Screen Printing', poNumber: '#0002', date: '2025-03-26', client: "Shaggy's Baggy Merch", grandTotal: 258.30, sourceFileId: '1jrnLnakuaabcAHNS-3YGaUc_MpqGgEZEetpH0hO1vIA', sourceTitle: "Ace PO - Shaggy's Baggy" },
  { vendor: 'Ace Screen Printing', poNumber: '#003', date: '2025-04-01', client: 'Green Gold Dispensary Merch', grandTotal: 3358.00, sourceFileId: '1hNwDeb_KUEBlUGG_vgOqEICfomtnckNuAXRCVWeKRVc', sourceTitle: 'Ace PO - Green Gold', flags: ['total-not-labeled-grand'] },
  { vendor: 'Ace Screen Printing', poNumber: '#0005', date: '2025-06-09', client: "Journee's Racing Merch", grandTotal: 872.41, sourceFileId: '1TnV6ZcHRYVP4tnO8c9gOgQH8-dL5TjTxWIVJoyzUXls', sourceTitle: 'Ace PO - Journees Racing' },
  { vendor: 'Ace Screen Printing', poNumber: '#0000', date: null, client: '', grandTotal: null, sourceFileId: '1i-k8GR2V14n6osdcg_T_XkCtgLW36QK3D1IPz_5sYes', sourceTitle: 'Ace PO - Template', skip: true, flags: ['template'] },

  // ── East End Ink (folder; the one doc's BODY says "Bic World" — flagged) ──────
  { vendor: 'East End Ink', poNumber: '#001', date: '2025-03-12', client: "Shaggy's Baggy Merch", grandTotal: 585.81, sourceFileId: '1wIR_B6mhc4gCapwuW1GhdVAT73-2SU2fEbXxqiDVlEE', sourceTitle: 'East End Ink PO #001', flags: ['body-names-different-printer:Bic World'] },

  // ── Full Designs ────────────────────────────────────────────────────────────
  { vendor: 'Full Designs', poNumber: '#001', date: null, client: 'Mad Martian Farms Merch', grandTotal: 369.90, sourceFileId: '1NayJ9tAnaeqCe-6XtqU0n5fR9r6F5EdJd0eWgBVyPaE', sourceTitle: 'Full Designs PO - #001', flags: ['no-date'] },

  // ── Contract-DTG ────────────────────────────────────────────────────────────
  { vendor: 'Contract-DTG', poNumber: '#0001', date: '2025-06-02', client: 'The CannaBoss Lady Merch', grandTotal: 1196.00, sourceFileId: '1LAXRN8IDusKm1L8hY_Oyg8tQ6dcBdI5EhOjXcjfNZrE', sourceTitle: 'Contract-DTG PO - #1' },
  { vendor: 'Contract-DTG', poNumber: '#0001 Reprint', date: '2025-07-03', client: 'The CannaBoss Lady Merch', grandTotal: 33.28, sourceFileId: '1zjW_O5xhFm4JX2cEbnaMo8QgDellE0ADy1jauwVRkUw', sourceTitle: 'Contract-DTG PO - #1 Reprint', flags: ['reprint'] },
  { vendor: 'Contract-DTG', poNumber: '#0002', date: '2025-12-08', client: 'The CannaBoss Lady Merch', grandTotal: 1189.76, sourceFileId: '1UYwP7QDjO8v5GbxvZA_IFSFnEU878Dn8lX-t15P7bpE', sourceTitle: 'Contract-DTG PO - #2' },
  { vendor: 'Contract-DTG', poNumber: '#0000', date: null, client: '', grandTotal: null, sourceFileId: '18t5nCq82GNLokylP1xpk1EmAaIROeGk-yqrcFwjXELc', sourceTitle: 'Contract-DTG PO - Template', skip: true, flags: ['template'] },

  // ── Global Promo (only doc is "Template"-titled but carries real data) ────────
  { vendor: 'Global Promo', poNumber: '#0000', date: '2025-04-04', client: 'Tempe History Museum Merch', grandTotal: 3090.00, sourceFileId: '1e56yg4zlUpfxatXLTBIFCKh6JMA3_6aDD3ytagx4zV0', sourceTitle: 'Global Promo PO - Template', flags: ['template-titled-but-has-real-data'] },

  // ── BIC (Bic World) ─────────────────────────────────────────────────────────
  { vendor: 'BIC', poNumber: '#001', date: '2025-03-12', client: "Shaggy's Baggy Merch", grandTotal: 585.81, sourceFileId: '1Wpz5LgdwodnPzwraTkcj20FzHiY4Uo-DwNzafp-s-Z0', sourceTitle: 'Bic World PO - #001' },
  { vendor: 'BIC', poNumber: '#002', date: '2026-02-25', client: "Shaggy's Baggy Merch", grandTotal: 576.49, sourceFileId: '1cZ50SwfLfqvqM5nSORy5bAJkoNpM9ZwfGad33eZ1xZQ', sourceTitle: 'BIC PO - #002' },

  // ── Cole Apparel (two docs both numbered #0001 — dup) ────────────────────────
  { vendor: 'Cole Apparel', poNumber: '#0001', date: '2025-02-26', client: 'Lean Gang Merch', grandTotal: 1197.50, sourceFileId: '1cU1kqHuUMHhgPRhClwpZEI7Eu1aLiqh-4d3bEjCq-MM', sourceTitle: 'Cole Apparel PO - Lean Gang #2', flags: ['dup-po-number'] },
  { vendor: 'Cole Apparel', poNumber: '#0001', date: '2025-02-27', client: 'Lean Gang Merch', grandTotal: 342.50, sourceFileId: '1JJbmQvf75p0BkKc__uP2YqgSO2sZ3p_OwTprR9i0Dds', sourceTitle: 'Cole Apparel PO - Lean Gang #1', flags: ['dup-po-number'] },
  { vendor: 'Cole Apparel', poNumber: '#0000', date: null, client: '', grandTotal: null, sourceFileId: '1_p3DJWlJLfN-sHztY0r1mhAtf18pULWWGD2HZCUdhF4', sourceTitle: 'Cole Apparel PO - Template', skip: true, flags: ['template'] },

  // ── BlueFrog ────────────────────────────────────────────────────────────────
  { vendor: 'BlueFrog', poNumber: '#001', date: '2025-02-07', client: 'Point in Time Studios Merch', grandTotal: null, sourceFileId: '11H3VgXirrRf5lUVgwcCp1b8E-XS1qRRb6c77t5SyAGU', sourceTitle: 'BlueFrog PO #001', flags: ['no-total', 'placeholder-amounts'] },
  { vendor: 'BlueFrog', poNumber: '#002', date: '2025-12-12', client: 'Good Company Merch', grandTotal: 1001.16, sourceFileId: '1X6Ds5dhCs-uboAIIhVeC1YWEsP07O6KOpBq50piuIYQ', sourceTitle: 'BlueFrog PO #002' },
  { vendor: 'BlueFrog', poNumber: '#0000', date: null, client: '', grandTotal: null, sourceFileId: '1pOfdlW_nQIBIiHwZOdzdpEgkI7b5GwAWgGkZKGUXqs8', sourceTitle: 'BlueFrog PO - Template', skip: true, flags: ['template'] },
  // BlueFrog's PO's subfolder: S&S Activewear supplier "Order Approval" acks for
  // the Good Company job (blank-supplier order confirmations, NOT JP→BlueFrog POs).
  // Recorded for provenance, NOT loaded as BlueFrog POs (would corrupt the data).
  { vendor: 'BlueFrog', poNumber: '002A', date: '2025-12-15', client: 'Good Company Merch', grandTotal: 985.90, sourceFileId: '1yYRhQXSAb8FGcBj5N5IxtT-DRuZNSK9v', sourceTitle: 'S&S Order Approval 339931 (002A)', skip: true, flags: ['not-a-po:blank-supplier-order-ack'] },
  { vendor: 'BlueFrog', poNumber: '002B', date: '2025-12-15', client: 'Good Company Merch', grandTotal: 218.80, sourceFileId: '15Ov7M_zS3uzs82lqeswkRcgqkbwxwEK-', sourceTitle: 'S&S Order Approval 339937 (002B)', skip: true, flags: ['not-a-po:blank-supplier-order-ack'] },
  { vendor: 'BlueFrog', poNumber: '002C', date: '2025-12-15', client: 'Good Company Merch', grandTotal: 148.80, sourceFileId: '1wAUeO8bi-Zo2QxaoLeeIJe-pIYf-2nIz', sourceTitle: 'S&S Order Approval 339948 (002C)', skip: true, flags: ['not-a-po:blank-supplier-order-ack'] },

  // ── Apollo (docs say "Apollo USA - East Coast"; ledger party "Apollo East") ───
  { vendor: 'Apollo', poNumber: '#0001', date: '2024-09-17', client: 'Jotkoff Financial Services Merch', grandTotal: 123.60, sourceFileId: '1zy9KMa8tJ28DeD-sCNUg4GR1sInh-4o9ZmMWn4u-T-I', sourceTitle: 'Apollo PO - #0001' },
  { vendor: 'Apollo', poNumber: '#0002', date: '2024-09-17', client: 'Almadelic Merch', grandTotal: 252.35, sourceFileId: '1k1cw1toBKUeSG--SryI2_Dog4gF7bbkhSxpD0B0XKc0', sourceTitle: 'Apollo PO - #0002' },
  { vendor: 'Apollo', poNumber: '#0003', date: '2024-12-13', client: 'Cannapi Merch', grandTotal: 815.29, sourceFileId: '1b5TW-F1dhnvDb07v8KfHhf9iiSxxSY0LeAXoE_p8UH8', sourceTitle: 'Apollo PO - #0003' },
  { vendor: 'Apollo', poNumber: '#0004', date: '2025-01-19', client: 'OS NYC Merch', grandTotal: 369.65, sourceFileId: '1EHnYDq6VXY5SFOfQsljROK4hU2290iWci_fdk-utX0g', sourceTitle: 'Apollo PO - #0004' },
  { vendor: 'Apollo', poNumber: '#0000', date: null, client: '', grandTotal: null, sourceFileId: '1_u5pi4XqLGWhyjiyiXOi7QIbitBGjbjht8NPo6aKm5E', sourceTitle: 'Apollo PO - Template', skip: true, flags: ['template'] },

  // ── Oklahoma Ink ────────────────────────────────────────────────────────────
  { vendor: 'Oklahoma Ink', poNumber: '#001A', date: '2025-12-16', client: "Duckie's Revenge Arcade Merch", grandTotal: 277.50, sourceFileId: '1cmqV1UIpRmrX7wEPSd59diOctaCHsql31pjQeGNCBLY', sourceTitle: 'Oklahoma Ink PO - #001A', flags: ['total-not-labeled-grand'] },
  { vendor: 'Oklahoma Ink', poNumber: '#001B', date: '2025-12-16', client: "Duckie's Revenge Arcade Merch", grandTotal: 230, sourceFileId: '1QmMHrKYL829vOIhvcvHyprIBOU_tEHu2HUgKU8bWDfE', sourceTitle: 'Oklahoma Ink PO - #001B', flags: ['total-not-labeled-grand'] },
  { vendor: 'Oklahoma Ink', poNumber: '#000', date: null, client: '', grandTotal: null, sourceFileId: '1cd-VMm0zwUnKuDmNg_LnrGQeeh7LfLm2jqI7v2bcwMU', sourceTitle: 'Oklahoma Ink PO - Template', skip: true, flags: ['template'] },

  // ── RedTupid ────────────────────────────────────────────────────────────────
  { vendor: 'RedTupid', poNumber: '#001', date: '2025-10-31', client: 'Vantage Real Estate Merch', grandTotal: 137.40, sourceFileId: '1OpXSUr8opgLkP4MsQkG7VI1ZSF_J9i34-xeoEoqvDJk', sourceTitle: 'RedTupid PO - #001' },

  // ── TekWeld (two docs both #0002 — dup) ──────────────────────────────────────
  { vendor: 'TekWeld', poNumber: '#0001', date: '2024-11-18', client: 'NJ Dental 1 Merch', grandTotal: 630, sourceFileId: '1pvr_HC3VebPU1h0MkCaWGo5LP3h7H4qY1j-v2biKbf8', sourceTitle: 'Tekweld PO - NJ Dental 1', flags: ['total-not-labeled-grand'] },
  { vendor: 'TekWeld', poNumber: '#0002', date: '2025-06-02', client: 'The Cannaboss Lady Merch', grandTotal: 302.40, sourceFileId: '10hyCZ0UdsvM4WJ0z7JBAKHjMzDJhJX6sS8YAA0UHCFU', sourceTitle: 'Tekweld PO - The Cannaboss Lady', flags: ['dup-po-number'] },
  { vendor: 'TekWeld', poNumber: '#0002', date: '2025-10-02', client: 'NJ Dental 1 Merch', grandTotal: 389.21, sourceFileId: '15AVIgBa-nyPe_hTU-BjNld8wBCxtX_rSOvvpYW6t8Kc', sourceTitle: 'Tekweld PO - NJ Dental 1 REPRINT', flags: ['dup-po-number', 'reprint', 'total-not-labeled-grand'] },

  // ── Stahls DFC ──────────────────────────────────────────────────────────────
  { vendor: 'Stahls DFC', poNumber: '#001', date: '2025-02-07', client: 'BodyArmor State Games Merch', grandTotal: 5457.22, sourceFileId: '1mw3TrTW1RRp0BZwgIuBo9cXknezF9jBee6Zko6Lzjdg', sourceTitle: 'Stahls DFC - PO #1' },
  { vendor: 'Stahls DFC', poNumber: '#0000', date: null, client: '', grandTotal: null, sourceFileId: '1B1f_XvNUCGT2p0Z_kS6-IEmKwdyLyNB_flphuPG-IDc', sourceTitle: 'Stahls DFC - PO', skip: true, flags: ['template'] },
];

// ── Vendor profile facts pulled from the PO docs (contact + address) ──────────
// The first PO that carried each printer's contact/address; used to seed the
// vendor card. Only printers whose docs actually carried these are listed.
const VENDOR_PROFILES = {
  'Heritage Screen Printing': { contactName: 'Jaide Thomas', address: '331 York Rd, Warminster, PA 18974', shipMethod: 'UPS Acct # JR2257' },
  'Cannabis Promotions':      { contactName: 'Mari Accioly', address: '2460 5th Ave S Suite A, St. Petersburg, FL 33712', shipMethod: 'UPS Acct # JR2257' },
  'Worldwide Promotion Inc':  { contactName: 'Vergil', email: 'vergil@wwidepromotion.com', phone: '626-662-2744', address: '444 East Huntington Drive, Suite 306-B, Arcadia, California 91006' },
  'Ace Screen Printing':      { contactName: 'Adam Szyfman', address: '54 Delsea Drive North, Glassboro, NJ 08028', shipMethod: 'UPS Acct # JR2257' },
  'Full Designs':             { contactName: 'Carol', shipMethod: 'Full Designs' },
  'Contract-DTG':             { contactName: 'Savanna', address: '217 W 11th St, Erie, PA 16501', shipMethod: 'UPS Acct # JR2257' },
  'Global Promo':             { contactName: 'Michele K. Richardson', address: '7895 Airport Hwy. Pennsauken, NJ 08109', shipMethod: 'UPS Acct # JR2257' },
  'Cole Apparel':             { contactName: 'Reyne Manzano', address: '1014 Griswold Ave, San Fernando, CA 91340', shipMethod: 'UPS Acct # JR2257' },
  'BlueFrog':                 { contactName: 'Stuart Smith', address: '717 Whitney St., San Leandro, CA 94577', shipMethod: 'UPS Acct # JR2257' },
  'Apollo':                   { contactName: 'Michele K. Richardson', address: '7895 Airport Hwy. Pennsauken, NJ 08109', shipMethod: 'UPS Acct # JR2257' },
  'Oklahoma Ink':             { contactName: 'Stephanie', address: '8618 E 46th St, Tulsa, OK 74145', shipMethod: 'UPS Acct # JR2257' },
  'TekWeld':                  { contactName: 'Debbie Solis', shipMethod: 'UPS Acct # JR2257' },
  'Stahls DFC':               { contactName: 'Brandy Cramer', address: '1 Stahls Dr, Masontown, PA 15461', shipMethod: 'UPS Acct # JR2257' },
};

// Canonical-name aliases the ledger / docs use for each printer, so vendor spend
// reconciles and dedup folds them. Keyed by canonical folder name. (vendorMatch's
// sameVendor catches most of these already; these are the explicit, owner-visible
// list — including the misspellings the ledger carries.)
const VENDOR_ALIASES = {
  'Heritage Screen Printing': ['Heritage', 'Hertage Screen Printing'],
  'Cannabis Promotions':      ['CannabisPromotions'],
  'Ace Screen Printing':      ['Ace'],
  'Apollo':                   ['Apollo East', 'Apollo USA', 'Apollo USA - East Coast'],
  'BlueFrog':                 ['Blue Frog'],
  'TekWeld':                  ['Tekweld'],
  'BIC':                      ['Bic', 'Bic World'],
  'East End Ink':             [],
};

const numOfPo = (po) => parseInt(String(po || '0').replace(/^#/, '').replace(/[^0-9].*$/, ''), 10) || 0;

function main() {
  const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));

  // Index COGS spend + orders by canonical vendor (the SAME canonicalizer the
  // reconcile uses), so the ledger's name variants fold onto the folder name.
  const aliasToCanon = new Map();
  for (const folder of VENDOR_FOLDERS) {
    aliasToCanon.set(folder.title.toLowerCase(), folder.title);
    for (const a of (VENDOR_ALIASES[folder.title] || [])) aliasToCanon.set(a.toLowerCase(), folder.title);
  }
  const canonOf = (party) => {
    const direct = aliasToCanon.get(String(party || '').trim().toLowerCase());
    if (direct) return direct;
    return canonicalVendorName(party, VENDOR_FOLDERS.map((f) => f.title)); // fuzzy
  };

  const spendByVendor = new Map(); // canon → { spend, orderNumbers:Set, ledgerParties:Set }
  for (const r of ledger) {
    if (r.category !== 'Printer/Blank COGS') continue;
    const canon = canonOf(r.party);
    if (!canon) continue; // a blank supplier (Alphabroder/S&S/Sanmar/Alibaba…) — not one of the 16 printers
    if (!spendByVendor.has(canon)) spendByVendor.set(canon, { spend: 0, orderNumbers: new Set(), ledgerParties: new Set() });
    const s = spendByVendor.get(canon);
    s.spend += (r.isCredit ? -1 : 1) * (Number(r.amount) || 0);
    if (r.orderNumber) s.orderNumbers.add(String(r.orderNumber).replace(/[^0-9]/g, '').replace(/^0+/, ''));
    s.ledgerParties.add(r.party);
  }

  // Build vendors (one per folder, canonical name) enriched from spend + profile.
  const vendors = VENDOR_FOLDERS.map((folder) => {
    const name = folder.title;
    const posForVendor = DRIVE_POS.filter((p) => p.vendor === name);
    const loadablePos = posForVendor.filter((p) => !p.skip);
    const sp = spendByVendor.get(name) || { spend: 0, orderNumbers: new Set(), ledgerParties: new Set() };
    const profile = VENDOR_PROFILES[name] || {};
    // nextPoStart: continue the real Drive run — the highest numeric PO seen + 1.
    const maxPo = loadablePos.reduce((m, p) => Math.max(m, numOfPo(p.poNumber)), 0);
    return {
      name,
      folderId: folder.id,
      aliases: VENDOR_ALIASES[name] || [],
      contactName: profile.contactName || '',
      email: profile.email || '',
      phone: profile.phone || '',
      address: profile.address || '',
      shipMethod: profile.shipMethod || '',
      totalSpend: Math.round(sp.spend * 100) / 100,
      orderNumbers: [...sp.orderNumbers].sort((a, b) => Number(a) - Number(b)),
      ledgerParties: [...sp.ledgerParties].sort(),
      poCount: loadablePos.length,
      nextPoStart: maxPo > 0 ? maxPo + 1 : 0,
    };
  });

  // Build purchaseOrders (loadable only) + a full audit list (incl. skipped).
  const purchaseOrders = DRIVE_POS.filter((p) => !p.skip).map((p) => ({
    vendorName: p.vendor,
    poNumber: p.poNumber,
    date: p.date,
    client: p.client || '',
    grandTotal: p.grandTotal,
    sourceFileId: p.sourceFileId,
    sourceTitle: p.sourceTitle,
    flags: p.flags || [],
  }));

  const skippedDocs = DRIVE_POS.filter((p) => p.skip).map((p) => ({
    vendorName: p.vendor, poNumber: p.poNumber, sourceFileId: p.sourceFileId,
    sourceTitle: p.sourceTitle, reason: (p.flags || ['skipped'])[0], flags: p.flags || [],
  }));

  const flaggedDocs = purchaseOrders.filter((p) => p.flags.length > 0);

  const seed = {
    generatedAt: new Date().toISOString(),
    source: "Owner's Google Drive 'POs' folder (one subfolder per printer)",
    folderId: '1VXfT9TD6w1hTq_nuovv_74b8jzzhusYN',
    vendors,
    purchaseOrders,
    skippedDocs,
    flaggedDocs,
    summary: {
      vendors: vendors.length,
      purchaseOrders: purchaseOrders.length,
      skippedDocs: skippedDocs.length,
      flaggedDocs: flaggedDocs.length,
      totalDriveSpend: Math.round(vendors.reduce((s, v) => s + v.totalSpend, 0) * 100) / 100,
      perVendor: vendors.map((v) => ({ name: v.name, poCount: v.poCount, totalSpend: v.totalSpend, orders: v.orderNumbers.length })),
    },
  };

  const json = JSON.stringify(seed, null, 2);
  fs.writeFileSync(OUT_BACKEND, json);
  try { fs.writeFileSync(OUT_SCRATCH, json); } catch (_) { /* scratch optional */ }

  // Console report (the "SUMMARY of the gathered data" for sanity-checking).
  console.log(`Wrote ${OUT_BACKEND}`);
  console.log(`Vendors: ${vendors.length} · POs loaded: ${purchaseOrders.length} · skipped: ${skippedDocs.length} · flagged: ${flaggedDocs.length}`);
  console.log('Per-vendor (poCount / totalSpend / #orders):');
  for (const v of vendors) {
    console.log(`  ${v.name.padEnd(28)} ${String(v.poCount).padStart(2)} POs   $${v.totalSpend.toFixed(2).padStart(9)}   ${v.orderNumbers.length} orders`);
  }
  console.log(`Total Drive-printer spend (from ledger): $${seed.summary.totalDriveSpend.toFixed(2)}`);
}

if (require.main === module) main();
module.exports = { DRIVE_POS, VENDOR_PROFILES, VENDOR_ALIASES, numOfPo };
