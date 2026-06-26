// services/financeSeed.js
//
// PURE categorization + party-normalization logic for the finance seed builder and
// the finance restart flow. No DB, no I/O — plain string in, plain data out — so
// the whole transformation is unit-testable against the owner's real descriptions.
//
// Two jobs:
//   1. categorize(desc, isIncome) → { category, party }
//      The SIDE (debit=income / credit=expense) is decided by the caller; here we
//      pick the finance category + extract the counterparty (customer for income,
//      vendor for expense) from the owner's free-text description.
//   2. canonicalParty(name) → name
//      Collapse the owner's spelling variants of the SAME party to one canonical
//      name (Heritage/"Hertage"/"Heritage Screen Printing" → "Heritage Screen
//      Printing", the four S&S spellings → "S&S Activewear", etc.), so per-vendor
//      and per-client rollups don't split one party across near-duplicate names.
//
// The category set MUST stay a subset of models/Transaction.js CATEGORIES so the
// existing P&L math (incomeContribution / orderRevenueContribution / COGS netting)
// treats every seeded row correctly with no changes:
//   income:  Customer Sales | Owner Contribution (equity, excluded) | Refund (contra)
//   expense: Blank COGS | Printer COGS | Shipping | Art | Commission | Software |
//            Owner Draw (equity, excluded) | Sales Tax | Other
// (Processing Fee exists for the live merchant-fee feature; the seed never mints it.)

// ── order-number hint ────────────────────────────────────────────────────────
// Canonical order-number key: strip every non-digit AND leading zeros, byte-for-
// byte identical to controllers/finances.js#normalizeOrderNumber so a seeded hint
// lines up with the rest of the system. '' when there are no digits.
function normalizeOrderNumber(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');
}

// Pull the owner's "(Order #N)" hint out of a description → normalized digits.
// This is a WEAK HINT (his manual sequence is unreliable), kept so the restart
// layer can use it as a secondary signal — never as order identity. '' if absent.
function parseOrderHint(desc) {
  const m = String(desc || '').match(/\(?\s*Order\s*#?\s*0*([0-9]+)\s*\)?/i);
  return m ? normalizeOrderNumber(m[1]) : '';
}

// ── party extraction ─────────────────────────────────────────────────────────
// Strip a trailing "(Order #…)" and any trailing qualifier notes the owner adds
// ("REPRINT", "REORDER", "1/2", "#2", "[tees]", "(Field Work)", "(JP Merch)",
// "(Sample)"…) to get the bare party/vendor name. Conservative: only removes the
// trailing decorations, never the core name.
function stripDecorations(s) {
  let v = String(s || '').trim();
  v = v.replace(/\(\s*Order\s*#?[^)]*\)/ig, '');     // "(Order #000083)"
  v = v.replace(/\(\s*[\d\s,&]+\)/g, '');            // "(91,83)" — a trailing order-# list (Commission rows)
  v = v.replace(/\b(reprint|reorder)\b/ig, '');      // trailing job notes
  v = v.replace(/\breship\b[^]*$/ig, '');            // "Reship (To Nate)" → drop to EOL
  v = v.replace(/\[[^\]]*\]/g, '');                  // "[tees]" / "[lipbalm]"
  v = v.replace(/\((?:field work|jp merch|sample)\)/ig, ''); // parenthetical context notes
  v = v.replace(/\b\d+\s*\/\s*\d+\b/g, '');          // "1/2", "2/2"
  v = v.replace(/#\s*\d+\b/g, '');                   // "#1", "#2"
  // Collapse any leftover empty parens / stray brackets from the removals above
  // (e.g. "UPS (...)" → "UPS  )" before this), then trim separators.
  v = v.replace(/\(\s*\)/g, '').replace(/[()[\]]/g, ' ');
  v = v.replace(/\s{2,}/g, ' ');
  return v.replace(/[\s\-–—:]+$/g, '').replace(/^[\s\-–—:]+/g, '').trim();
}

// Income-side description → customer name. Most income rows are
// "Sales - <Customer> (Order #N)"; some are bare ("JFS", "VT3D") or refunds.
function incomeParty(desc) {
  let d = String(desc || '').trim();
  // A refund row may lead with "Refund - <Party>" or "Sales - <Party> ... Refund/
  // Sample Return" — peel a leading "Refund -"/"Sales -" so the party is the bare
  // customer/counterparty name (e.g. "Refund - Shaggy's Baggy" → "Shaggy's Baggy").
  d = d.replace(/^\s*Refund\s*-\s*/i, '');
  const m = d.match(/^\s*Sales\s*-\s*(.+)$/i);
  let core = m ? m[1] : d;
  // Drop a trailing "… Refund" / "… Sample Return" qualifier so the party is clean.
  core = core.replace(/\b(sample\s+return|sample\s+refund|refund)\s*\d*$/i, '');
  return stripDecorations(core);
}

// Expense-side description → vendor name. Many expense rows mirror the income
// shape ("Sales - <Vendor> (Order #N)" = a cost paid to that vendor) or a prefixed
// shape ("Shipping - UPS …", "Art - Denis …", "Commission - Alvin …",
// "Gas - Costco …"); others are a bare vendor/tool ("Render", "OpenAI"). We take
// the segment after a leading "<Prefix> -" when present, else the whole thing.
const EXPENSE_PREFIX_RE = /^\s*(?:Sales|Shipping|Art|Commission|Marketing|Gas|Parking|Water)\s*-\s*(.+)$/i;
function expenseParty(desc) {
  const d = String(desc || '').trim();
  const m = d.match(EXPENSE_PREFIX_RE);
  const core = m ? m[1] : d;
  return stripDecorations(core);
}

// ── party canonicalization (spelling-variant dedup) ──────────────────────────
// The owner spells some parties several ways across months. Collapse each to ONE
// canonical name so vendor/client rollups don't fragment. Matched on a normalized
// (lowercased, non-alphanumeric-stripped) form so spacing/punctuation/case never
// matters. Order matters only for readability; keys are independent.
const PARTY_CANON = [
  // Heritage Screen Printing — incl. the "Hertage" typo and the bare "Heritage".
  { test: (n) => /^heritage|^hertage/.test(n), to: 'Heritage Screen Printing' },
  // S&S Activewear — "S&S Activewear", "S&SActivewear", "S&S Activewear Samples",
  // "S&S Sample Return", "S&S Activewear Samples 2" all → the one vendor.
  { test: (n) => /^s\s*&?\s*s\s*activewear|^s\s*&?\s*s\s*sample/.test(n), to: 'S&S Activewear' },
  // Cannabis Promotions — "Cannabis Promotions" / "CannabisPromotions".
  { test: (n) => /^cannabispromotions$|^cannabis promotions/.test(n), to: 'Cannabis Promotions' },
  // The Cannaboss Lady — case variants ("The CannaBoss Lady" / "The Cannaboss Lady").
  { test: (n) => /^the cannaboss lady$/.test(n), to: 'The Cannaboss Lady' },
  // OS NYC — "OS NYC" + its sample row.
  { test: (n) => /^os nyc/.test(n), to: 'OS NYC' },
  // Apollo — "Apollo East" is the same printer family.
  { test: (n) => /^apollo/.test(n), to: 'Apollo East' },
  // Alibaba — the long legal-name variant collapses to the short one.
  { test: (n) => /^alibaba/.test(n), to: 'Alibaba' },
  // Vistaprint — "VistaPrint" / "Vistaprint".
  { test: (n) => /^vistaprint/.test(n), to: 'Vistaprint' },
  // Namecheap — "Namecheap" / "Namecheap Domain".
  { test: (n) => /^namecheap/.test(n), to: 'Namecheap' },
  // Alphabroder — "Alphabroder" / "Alphabroder Samples" → one blank supplier.
  { test: (n) => /^alphabroder/.test(n), to: 'Alphabroder' },
  // Bic — "Bic" / "Bic World" → one promo-blank supplier.
  { test: (n) => /^bic\b/.test(n), to: 'Bic' },
  // Worldwide Promotion Inc → short canonical.
  { test: (n) => /^worldwide/.test(n), to: 'Worldwide' },
  // Ace Screen Printing — sample row variants collapse to the printer.
  { test: (n) => /^ace screen/.test(n), to: 'Ace Screen Printing' },
  // ── client-side same-company variants (a "Sample"/"Close Out"/"2" suffix is the
  // SAME customer; fragmenting them would split one client's rollup) ──
  { test: (n) => /^human af/.test(n), to: 'Human AF' },
  { test: (n) => /^joint chiropractic/.test(n), to: 'Joint Chiropractic' },
  { test: (n) => /^shaggy'?s baggy/.test(n), to: "Shaggy's Baggy" },
  { test: (n) => /^stadium gardens/.test(n), to: 'Stadium Gardens' },
];

const normName = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9&]+/g, '');

function canonicalParty(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const n = raw.toLowerCase();
  for (const rule of PARTY_CANON) {
    if (rule.test(n)) return rule.to;
  }
  return raw;
}

// ── category rules ───────────────────────────────────────────────────────────
// Vendors whose COST is the BLANK garment/product (apparel & promo blanks). These
// → 'Blank COGS'. The owner's blank suppliers: Alphabroder, S&S/Sanmar, and the
// promo-blank importers (Alibaba, Bic, Tekweld, Worldwide, Hospitality Mints,
// Cannabis Promotions as a promo-product supplier).
const BLANK_VENDORS = [
  /alphabroder/i, /s\s*&?\s*s\s*activewear/i, /sanmar/i, /alibaba/i, /\bbic\b/i,
  /tekweld/i, /worldwide/i, /hospitality mints/i, /cannabis ?promotions/i,
  /custom patch factory/i, /anbernic/i,
];
// Vendors whose COST is the PRINTING/decoration → 'Printer COGS'.
const PRINTER_VENDORS = [
  /heritage/i, /hertage/i, /ace screen/i, /blue frog/i, /apollo/i, /oklahoma ink/i,
  /full designs/i, /contract-?dtg/i, /redtupid/i,
];
// Shipping carriers / freight → 'Shipping'.
const SHIPPING_VENDORS = [/\bups\b/i, /\busps\b/i, /fedex/i, /arcbest/i];
// Art / design contractors → 'Art'.
const ART_VENDORS = [/wise payments/i, /\bdenis\b/i, /gathonj/i, /hussein/i, /\bdaniel\b/i, /\bmilo\b/i];
// Software / SaaS / tooling → 'Software'.
const SOFTWARE_VENDORS = [
  /render/i, /google workspace/i, /openai/i, /chatgpt/i, /anthropic/i, /claude/i,
  /midjourney/i, /quickbooks/i, /namecheap/i, /webworks/i, /logitech/i, /\bwgk\b/i,
  /notion/i, /snov\.io/i, /vectorizer/i, /\byamm\b/i,
];
// Marketing / ads / promo collateral → 'Marketing'.
const MARKETING_VENDORS = [/meta ads/i, /stickermule/i, /\bnfc\b/i, /vistaprint/i];
// Travel / field work → 'Other' bucket is too coarse; the owner wants Travel/Field.
const TRAVEL_VENDORS = [
  /\bgas\b/i, /parking/i, /parkmobile/i, /amtrak/i, /nj transit/i, /allianz/i,
  /\bcostco\b/i, /\bwater\b.*costco/i,
];

const anyMatch = (res, s) => res.some((re) => re.test(s));

// EXPENSE description → category. The party (vendor) is extracted separately; here
// we look at the FULL description so prefixes like "Shipping -"/"Art -"/"Gas -"
// and tool names are all visible. Order matters — most specific first.
function categorizeExpense(desc) {
  const d = String(desc || '');
  // Owner equity OUT — "Owner's Withdrawal" (and the missing-apostrophe spelling).
  if (/owner'?s?\s*withdrawal/i.test(d)) return 'Owner Draw';
  // Sales tax remitted to the state.
  if (/nj (sales )?tax/i.test(d) || /division of revenue/i.test(d) || /sales tax/i.test(d)) return 'Sales Tax';
  // Accounting fees (Jotkoff).
  if (/jotkoff/i.test(d) || /accounting fees/i.test(d)) return 'Accounting';
  // Commission (Alvin) — explicit prefix.
  if (/^\s*commission\b/i.test(d) || /\balvin\b/i.test(d)) return 'Commission';
  // Art / design contractor work — explicit prefix or a known artist.
  if (/^\s*art\b/i.test(d) || anyMatch(ART_VENDORS, d)) return 'Art';
  // Shipping — explicit prefix, a carrier name (incl. "Sales - UPS …",
  // "Sales - ArcBest …" which are freight costs), or the owner's "Sales - Shipping
  // (Order #N)" pass-through freight line (no carrier named).
  if (/^\s*shipping\b/i.test(d) || /^\s*sales\s*-\s*shipping\b/i.test(d) || anyMatch(SHIPPING_VENDORS, d)) return 'Shipping';
  // Marketing / ads / promo collateral.
  if (/^\s*marketing\b/i.test(d) || anyMatch(MARKETING_VENDORS, d)) return 'Marketing';
  // Travel / field work (gas, parking, transit, trip insurance, Costco runs).
  if (anyMatch(TRAVEL_VENDORS, d)) return 'Travel/Field';
  // Software / SaaS / tooling.
  if (anyMatch(SOFTWARE_VENDORS, d)) return 'Software';
  // Printer COGS (decoration) vs Blank COGS (garment/product) — by vendor family.
  if (anyMatch(PRINTER_VENDORS, d)) return 'Printer COGS';
  if (anyMatch(BLANK_VENDORS, d)) return 'Blank COGS';
  // Everything else → Other (one-off purchases, reimbursements, mockup-gen Venmos).
  return 'Other';
}

// INCOME description → category. Default Customer Sales, with two carve-outs:
//   • "Owner's Deposit" → Owner Contribution (owner capital IN, NOT a sale).
//   • a refund / sample-return coming back to us → Refund (contra-revenue).
function categorizeIncome(desc) {
  const d = String(desc || '');
  if (/owner'?s?\s*deposit/i.test(d)) return 'Owner Contribution';
  // Refunds / sample returns on the income side (money coming BACK to us):
  // "* Refund", "* Sample Return", "* Sample Refund", "Amtrak/Allianz Refund".
  if (/\brefund\b/i.test(d) || /sample return/i.test(d) || /sample refund/i.test(d)) return 'Refund';
  return 'Customer Sales';
}

// The one entry point the builder/restart call: full description + which side it
// came from → { category, party }. The side is authoritative for direction.
function categorize(desc, isIncome) {
  if (isIncome) {
    return { category: categorizeIncome(desc), party: incomeParty(desc) };
  }
  return { category: categorizeExpense(desc), party: expenseParty(desc) };
}

module.exports = {
  categorize,
  categorizeIncome,
  categorizeExpense,
  incomeParty,
  expenseParty,
  canonicalParty,
  normalizeOrderNumber,
  parseOrderHint,
  stripDecorations,
  normName,
  // exported for tests / reuse
  PARTY_CANON,
};
