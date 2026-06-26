// services/financeDedupe.js
//
// PURE logic for the owner-triggered "Merge duplicate transactions" flow — the
// finance analogue of services/crmReconcile.js' dedup, but for the LIVE ledger AFTER
// the budget restart has run. No DB, no Express, no I/O: every function takes plain
// data in and returns plain data out, so the whole detector + merge is unit-testable
// against POJOs, and the endpoints (controllers/financeDedupe.js) stay thin wrappers.
//
// THE PROBLEM IT SOLVES
//   The "restart finances from my budgets" flow PRESERVED the owner's pre-existing
//   MANUAL transactions and ALSO loaded the same real payments from his budget — so
//   the ledger now has CROSS-SOURCE duplicate rows for a handful of payments. The
//   restart's own dedup missed them because it required a same-calendar-DAY match, but
//   the owner's manual-entry date and the budget date for the SAME payment drift by
//   ~2 weeks. He does NOT want to delete either — each row carries DIFFERENT linked
//   data (one has the project/order link, the other an uploaded receipt + invoice #).
//   So we MERGE each duplicate pair into ONE transaction that keeps EVERY link, and
//   remove the now-redundant row so the amount counts ONCE.
//
// WHAT IS (and is NOT) A DUPLICATE — the safety contract
//   A duplicate PAIR is exactly ONE budget/restart-sourced row + ONE manual/receipt-
//   sourced row (a human-created row that can carry a receipt/invoice/link) that share
//   ALL of:
//     • the SAME amount (to the cent),
//     • the SAME direction — same type (income/expense) AND same isCredit,
//     • a FUZZY-SAME party (reuses the codebase's conservative samePartyOrDesc, which
//       wraps utils/vendorMatch.sameVendor + a shared meaningful party/description
//       token), and
//     • dates within a window (default 45 days — wide enough for the manual-vs-budget
//       drift, narrow enough that two genuinely-separate charges months apart don't
//       collide).
//   The CROSS-SOURCE requirement is the key guard that prevents false-merging two
//   genuinely-distinct RECURRING charges: two separate monthly $20 OpenAI charges are
//   BOTH manual (same source) → never a pair, even though amount + party match. Two
//   budget rows are likewise never a pair. Only a budget↔manual crossing, with the
//   amount + party + window ALL satisfied together, qualifies.

const { sameVendor, vendorTokens } = require('../utils/vendorMatch');

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

// Canonical order-number key — byte-for-byte identical to controllers/finances.js,
// services/crmReconcile.js, and services/financeRestart.js so every layer lines up.
// '' when there are no digits.
function normalizeOrderNumber(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');
}

// ── which rows can take part in a cross-source merge ─────────────────────────
// The two SIDES of a duplicate pair. A "budget" row is the restart/budget batch's
// copy (source 'budget'). A "manual" row is anything a person created and that can
// carry a receipt/invoice/link: 'manual' (default), 'receipt' (booked from an
// uploaded receipt), or '' (legacy default). We deliberately EXCLUDE the automated
// rows that are never the owner's hand entry:
//   • 'import'   — a CSV re-import (its own idempotent replace path),
//   • 'order:auto' / 'fee:auto' — system-generated rows tied to an order/payment,
//   • 'merge'    — a survivor of a PRIOR merge (already deduped; never re-merge it).
const MANUAL_SOURCES = new Set(['manual', 'receipt', '']);
function isBudgetRow(t) { return !!t && t.source === 'budget'; }
function isManualRow(t) { return !!t && MANUAL_SOURCES.has(t.source == null ? '' : t.source); }

// ── date helpers ─────────────────────────────────────────────────────────────
// Calendar-day key (ISO YYYY-MM-DD) for a Date or ISO string; '' if unparseable.
function dateKey(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}
// Whole-day distance between two rows' dates (absolute). Returns Infinity when either
// date is missing/unparseable, so a dateless row can never fall "within the window"
// and be merged on date proximity (it would need an exact other signal, which we
// don't grant — dateless rows are left alone).
function daysApart(a, b) {
  const ka = dateKey(a && a.date);
  const kb = dateKey(b && b.date);
  if (!ka || !kb) return Infinity;
  const da = new Date(`${ka}T00:00:00Z`).getTime();
  const db = new Date(`${kb}T00:00:00Z`).getTime();
  if (isNaN(da) || isNaN(db)) return Infinity;
  return Math.abs(db - da) / 86400000;
}

// ── party sameness — the conservative counterparty-identity gate ─────────────
// This is the one gate standing between "drifted duplicate of the same payment" and
// "two distinct vendors that merely cost the same", so it is deliberately strict and
// PARTY-ONLY (the free-text DESCRIPTION is never used for identity — that's where
// descriptor collisions like "web hosting" vs "web design" live).
//
// PURE-BOILERPLATE party words — the ONLY tokens we may strip from a PARTY name when
// deciding identity in the fallback below. These carry no distinguishing identity:
// generic API/billing words + corporate entity types. Crucially this set does NOT
// include DISTINGUISHING trade words ("apparel", "sportswear", "studio", "graphics",
// "dispensary"…) — stripping those would wrongly collapse a real, separate business
// ("Apex" vs "Apex Apparel"). It is a deliberately TIGHT list (entity types + generic
// API/billing words only), strictly narrower than vendorMatch's own suffix stripping.
const PARTY_BOILERPLATE = new Set([
  'api', 'app', 'subscription', 'subscriptions', 'monthly', 'annual', 'yearly', 'plan',
  'plus', 'pro', 'premium', 'renewal', 'membership', 'account', 'billing',
  'inc', 'llc', 'co', 'corp', 'ltd', 'company', 'incorporated', 'corporation', 'limited',
  'the', 'and',
]);
// A party name reduced to its DISTINCTIVE tokens (lowercased, punctuation-split, digits
// + pure boilerplate dropped, ≥2 chars kept so a short real stem survives). The PARTY is
// the counterparty identity; the free-text DESCRIPTION is deliberately NEVER consulted
// for identity (that's where "web"/"design"/"software" descriptor collisions live).
function distinctivePartyTokens(name) {
  return vendorTokens(name)
    .filter((w) => w && !/^\d+$/.test(w) && !PARTY_BOILERPLATE.has(w));
}

// Do two rows refer to the SAME counterparty? Deliberately CONSERVATIVE — this is the
// one gate standing between "drifted duplicate of the same payment" and "two distinct
// vendors that merely cost the same". TWO ways to qualify, both PARTY-only:
//   1) the codebase's conservative sameVendor on the PARTY names passes ("Happy Leaf" ≈
//      "Happy Leaf Dispensary" via its prefix/overlap rules) — the primary signal; OR
//   2) the two parties are EQUAL once only PURE-BOILERPLATE words are dropped ("Anthropic"
//      ≡ "Anthropic API"; "Acme" ≡ "Acme Inc"). This catches the boilerplate tail
//      sameVendor doesn't know ("api") WITHOUT loosening it: because we only strip
//      boilerplate (never a distinguishing word), "Apex" vs "Apex Apparel" stays
//      {apex} ≠ {apex, apparel} → NO match, and a single shared ORDINARY word can never
//      make two different multi-word names equal.
// We do NOT match on a shared description token, and a shared lone descriptor word is
// never identity. So "CloudAlpha — web hosting" vs "BetaStudio — web design" does NOT
// match. Both parties blank ⇒ never a match (won't collapse two anonymous rows).
function samePartyOrDesc(a, b) {
  const pa = String((a && a.party) || '').trim();
  const pb = String((b && b.party) || '').trim();
  if (!pa || !pb) return false;                 // identity must come from a real party name
  if (sameVendor(pa, pb)) return true;          // (1) conservative same-vendor — the main signal

  // (2) Equal after dropping ONLY boilerplate. Require a non-empty distinctive stem with
  //     a real (≥3-char) token so a coincidental empty/short reduction can't match.
  const ta = distinctivePartyTokens(pa);
  const tb = distinctivePartyTokens(pb);
  if (!ta.length || !tb.length) return false;
  const sa = [...new Set(ta)].sort();
  const sb = [...new Set(tb)].sort();
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return sa.some((t) => t.length >= 3);         // the shared stem must be a real word
}

// ── the coarse bucket two rows must share to even be candidates ──────────────
// amount (to the cent) + direction (type + isCredit). NOT the date (the whole point is
// the dates drift) and NOT the order # (the budget row and the manual row carry
// DIFFERENT links — that's why we're merging). A row with a non-finite amount is
// given a unique key so it can only ever match itself (never merged).
function bucketKey(t) {
  const amt = round2(t && t.amount);
  if (!Number.isFinite(amt) || amt <= 0) return `bad|${Math.random()}`;
  const dir = `${(t && t.type) || ''}|${(t && t.isCredit) ? 'cr' : 'db'}`;
  return `${amt.toFixed(2)}|${dir}`;
}

// ── richness: which field/value to keep when both rows carry one ─────────────
// "How linked is this row" — used only as a tiebreak for which row to treat as the
// survivor when both are equally valid (we always survive the BUDGET row for stable
// order rollups, so this is informational/for the preview).
function linkScore(t) {
  if (!t) return 0;
  return (t.receiptUrl ? 1 : 0)
    + (normalizeOrderNumber(t.orderNumber) ? 1 : 0)
    + (String(t.invoiceNumber || '').trim() ? 1 : 0);
}
// Pick the "richer" party name — the longer / more specific one ("Happy Leaf
// Dispensary" over "Happy Leaf"), preferring a non-empty value. Ties keep `a`.
function richerParty(a, b) {
  const pa = String((a && a.party) || '').trim();
  const pb = String((b && b.party) || '').trim();
  if (!pa) return pb;
  if (!pb) return pa;
  return pb.length > pa.length ? pb : pa;
}
// Combine two free-text fields without losing either: keep both distinct, non-empty
// values joined by ' · '. Identical/substring values collapse to the longer one so we
// don't render "Anthropic API · Anthropic API".
function combineText(a, b) {
  const xa = String(a || '').trim();
  const xb = String(b || '').trim();
  if (!xa) return xb;
  if (!xb) return xa;
  if (xa === xb) return xa;
  const la = xa.toLowerCase();
  const lb = xb.toLowerCase();
  if (la.includes(lb)) return xa;
  if (lb.includes(la)) return xb;
  return `${xa} · ${xb}`;
}

// ── merge two rows into ONE survivor that UNIONS every field/link ────────────
// The SURVIVOR is the budget row (so any order/category rollups keyed on its identity
// stay stable and the amount counts once where it always did); the manual/receipt row
// is the one folded in and then removed. We pull EVERY link off the folded row that
// the survivor is missing — a receipt or order/invoice link is NEVER lost:
//   • receiptUrl   — keep whichever side has one (survivor's wins only if non-empty).
//   • orderNumber  — keep a non-empty NORMALIZED order/project link from either side.
//   • invoiceNumber— keep a non-empty invoice # from either side.
//   • party        — the richer (more specific) name.
//   • description  — both, combined (never dropped).
//   • category     — the budget (survivor) category is authoritative unless blank.
//   • isCredit     — identical by construction (same direction bucket); keep it.
//   • qbSynced     — OR (if either was reconciled in QB, the merged row is).
//   • paymentMethod/feeRateOverride — keep a non-empty value from either side.
//   • source       — 'merge' (records that this row is a merge result).
//
// CONFLICTING links (both rows carry a DIFFERENT non-empty receipt / order # / invoice
// #): a single-valued field can only hold ONE, so the survivor's wins as the live link —
// but the loser is NEVER lost: it is (a) kept verbatim in the `mergedFrom` audit snapshot
// AND (b) appended to the combined description as a "(also …)" note, so a clickable/
// retrievable trace of every link remains on the surviving row. (In the owner's real
// cases the links are asymmetric — one side has the receipt, the other the order/invoice —
// so there is no conflict and nothing to note.)
// Returns { survivorId, set } where `set` is the field patch to apply to the survivor,
// plus `mergedFrom` (a snapshot of the folded row for the audit trail). Pure.
function mergeTransactions(budgetRow, manualRow) {
  const survivor = budgetRow;
  const folded = manualRow;

  const sOrder = normalizeOrderNumber(survivor.orderNumber);
  const fOrder = normalizeOrderNumber(folded.orderNumber);
  const sInvoice = String(survivor.invoiceNumber || '').trim();
  const fInvoice = String(folded.invoiceNumber || '').trim();
  const sReceipt = String(survivor.receiptUrl || '').trim();
  const fReceipt = String(folded.receiptUrl || '').trim();

  const orderNumber = sOrder || fOrder;
  const invoiceNumber = sInvoice || fInvoice;
  const receiptUrl = sReceipt || fReceipt;
  const paymentMethod = String(survivor.paymentMethod || '').trim()
    || String(folded.paymentMethod || '').trim();
  const feeRateOverride = (survivor.feeRateOverride != null)
    ? survivor.feeRateOverride
    : (folded.feeRateOverride != null ? folded.feeRateOverride : null);

  // CONFLICTS: a value present on BOTH sides but DIFFERENT — the kept field takes the
  // survivor's, so capture the folded side's losing value to append to the description
  // (it also lives in mergedFrom). No conflict ⇒ no note.
  const conflictNotes = [];
  if (sOrder && fOrder && sOrder !== fOrder) conflictNotes.push(`also order #${fOrder}`);
  if (sInvoice && fInvoice && sInvoice !== fInvoice) conflictNotes.push(`also invoice #${fInvoice}`);
  if (sReceipt && fReceipt && sReceipt !== fReceipt) conflictNotes.push(`also receipt ${fReceipt}`);

  // A compact snapshot of the folded row — enough to SEE what was combined and to
  // restore it on revert (the full row is also backed up in the batch).
  const foldedSnapshot = {
    _id: folded._id,
    date: folded.date,
    type: folded.type,
    category: folded.category,
    party: folded.party,
    description: folded.description,
    amount: folded.amount,
    isCredit: !!folded.isCredit,
    orderNumber: folded.orderNumber || '',
    invoiceNumber: folded.invoiceNumber || '',
    receiptUrl: folded.receiptUrl || '',
    source: folded.source || '',
  };

  let description = combineText(survivor.description, folded.description);
  if (conflictNotes.length) description = combineText(description, `(${conflictNotes.join('; ')})`);

  const set = {
    orderNumber,
    invoiceNumber,
    receiptUrl,
    party: richerParty(survivor, folded),
    description,
    category: String(survivor.category || '').trim() || folded.category || 'Other',
    isCredit: !!survivor.isCredit,
    qbSynced: !!survivor.qbSynced || !!folded.qbSynced,
    paymentMethod,
    feeRateOverride,
    source: 'merge',
    // Preserve any earlier merge audit, then append this fold.
    mergedFrom: [...(Array.isArray(survivor.mergedFrom) ? survivor.mergedFrom : []), foldedSnapshot],
  };

  return { survivorId: survivor._id, removeId: folded._id, set, foldedSnapshot };
}

// ── a preview-friendly projection of one row (for the side-by-side UI) ───────
function previewRow(t) {
  if (!t) return null;
  return {
    id: t._id != null ? String(t._id) : '',
    date: t.date,
    type: t.type,
    category: t.category,
    party: t.party || '',
    description: t.description || '',
    amount: round2(t.amount),
    isCredit: !!t.isCredit,
    orderNumber: t.orderNumber || '',
    invoiceNumber: t.invoiceNumber || '',
    receiptUrl: t.receiptUrl || '',
    source: t.source || '',
  };
}
// The merged-row preview (what the single surviving row WILL look like). Built from
// the same merge math the apply uses, so preview == reality.
function mergedPreview(budgetRow, manualRow) {
  const { set } = mergeTransactions(budgetRow, manualRow);
  return {
    date: budgetRow.date,
    type: budgetRow.type,
    category: set.category,
    party: set.party,
    description: set.description,
    amount: round2(budgetRow.amount),
    isCredit: set.isCredit,
    orderNumber: set.orderNumber,
    invoiceNumber: set.invoiceNumber,
    receiptUrl: set.receiptUrl,
    // The links the merge is preserving, surfaced explicitly for the UI/tests.
    keepsReceipt: !!set.receiptUrl,
    keepsOrderLink: !!set.orderNumber,
    keepsInvoice: !!set.invoiceNumber,
  };
}

// ── the detector: find cross-source duplicate pairs ──────────────────────────
// Returns an array of pairs, each { key, budget, manual, daysApart, merged } where
// `budget`/`manual` are the two original rows and `merged` is the merged preview.
//
// Algorithm:
//   1) Bucket every eligible row by (amount|type|isCredit). Only rows sharing that
//      exact coarse key can ever pair.
//   2) Within each bucket, split into budget rows and manual rows.
//   3) Build every (budget, manual) candidate that is samePartyOrDesc AND within the
//      date window; sort candidates by smallest date gap.
//   4) Greedily accept candidates in that order, each row used AT MOST ONCE — so a
//      bucket with 1 budget + 3 manual rows yields exactly ONE pair (the closest),
//      and the other two manual rows are left untouched (they are NOT budget twins).
//      This is what keeps two genuinely-distinct recurring charges from collapsing.
//
// DATE WINDOW (default 30 days). The owner's real manual-vs-budget drift is ~2 weeks
// (his known cases are 13–14 days apart). 30 days is ~2× that — comfortable headroom —
// while staying BELOW a monthly billing cycle (28–31 days), so a budget row for month N
// and a manual row for month N+1 of the SAME recurring subscription do NOT fall in the
// window and are never merged as a "duplicate". (Even same-vendor, two real monthly
// charges are distinct payments, not a drifted dup.) The window is overridable for tests.
function findDuplicatePairs(transactions, opts = {}) {
  const windowDays = opts.windowDays != null ? opts.windowDays : 30;
  const rows = (Array.isArray(transactions) ? transactions : []).filter(Boolean);

  // Bucket by coarse key.
  const buckets = new Map();
  for (const t of rows) {
    const k = bucketKey(t);
    if (k.startsWith('bad|')) continue;            // non-positive / non-finite amount → skip
    const b = buckets.get(k) || { budget: [], manual: [] };
    if (isBudgetRow(t)) b.budget.push(t);
    else if (isManualRow(t)) b.manual.push(t);     // import/order:auto/fee:auto/merge are ignored
    buckets.set(k, b);
  }

  const pairs = [];
  for (const [key, b] of buckets) {
    if (!b.budget.length || !b.manual.length) continue;   // need BOTH sides to cross-merge

    // All viable (budget, manual) candidates in this bucket, with their date gap.
    const cands = [];
    for (const bg of b.budget) {
      for (const mn of b.manual) {
        const gap = daysApart(bg, mn);
        if (gap <= windowDays && samePartyOrDesc(bg, mn)) {
          cands.push({ bg, mn, gap });
        }
      }
    }
    // Closest dates first. Tiebreak on the row ids so the greedy choice is FULLY
    // deterministic regardless of the order the rows arrived in (a DB find() has no
    // guaranteed order) — two runs on the same data always pick the same pairs.
    const idOf = (t) => String((t && t._id) != null ? t._id : '');
    cands.sort((x, y) => (x.gap - y.gap)
      || idOf(x.bg).localeCompare(idOf(y.bg))
      || idOf(x.mn).localeCompare(idOf(y.mn)));

    const usedBudget = new Set();
    const usedManual = new Set();
    for (const c of cands) {
      if (usedBudget.has(c.bg) || usedManual.has(c.mn)) continue;   // one-to-one only
      usedBudget.add(c.bg);
      usedManual.add(c.mn);
      pairs.push({
        // Content-derived, ORDER-INDEPENDENT key (the two row ids), so a `pairKey` the
        // UI captured in the preview still matches the SAME pair on apply even if the
        // DB returns rows in a different order between the two requests. (An index-based
        // key would silently shift and merge the wrong pair.)
        key: `${idOf(c.bg)}|${idOf(c.mn)}`,
        budget: c.bg,
        manual: c.mn,
        daysApart: Math.round(c.gap),
        merged: mergedPreview(c.bg, c.mn),
      });
    }
  }

  // Deterministic output order: by amount desc, then date, then the stable pair key
  // (so the list order never depends on the DB's row order).
  pairs.sort((a, b) => round2(b.budget.amount) - round2(a.budget.amount)
    || dateKey(b.budget.date).localeCompare(dateKey(a.budget.date))
    || String(a.key).localeCompare(String(b.key)));
  return pairs;
}

// ── the PLAN the preview returns and the apply consumes ──────────────────────
// Each pair becomes a "group" (the budget row + the manual row side by side, plus the
// merged result) the UI renders. We also surface a count of how many receipts / order
// links / invoice #s the merge will PRESERVE (the owner's reassurance that nothing is
// lost). Pure: pass the already-fetched live rows in.
function buildDedupePlan(transactions, opts = {}) {
  const pairs = findDuplicatePairs(transactions, opts);
  const groups = pairs.map((p) => ({
    key: p.key,
    daysApart: p.daysApart,
    budget: previewRow(p.budget),
    manual: previewRow(p.manual),
    merged: p.merged,
  }));
  const receiptsPreserved = pairs.filter((p) => p.merged.keepsReceipt).length;
  const orderLinksPreserved = pairs.filter((p) => p.merged.keepsOrderLink).length;
  const invoicesPreserved = pairs.filter((p) => p.merged.keepsInvoice).length;
  return {
    pairCount: pairs.length,
    groups,
    summary: {
      duplicatePairs: pairs.length,
      receiptsPreserved,
      orderLinksPreserved,
      invoicesPreserved,
    },
    // The raw pairs (with the live rows) — the apply layer consumes these.
    pairs,
  };
}

module.exports = {
  findDuplicatePairs,
  buildDedupePlan,
  mergeTransactions,
  mergedPreview,
  previewRow,
  samePartyOrDesc,
  isBudgetRow,
  isManualRow,
  bucketKey,
  daysApart,
  richerParty,
  combineText,
  linkScore,
  normalizeOrderNumber,
  round2,
  MANUAL_SOURCES,
};
