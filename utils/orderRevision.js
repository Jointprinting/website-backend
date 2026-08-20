'use strict';

// ── Optimistic concurrency for the two subtrees that get written WHOLE ───────
//
// PUT /api/orders/:id does `$set: {...body}`, and the quote and confirmation
// builders send the ENTIRE `quoteLines[]` / `confirmation` subtree on every
// autosave — 800ms after a keystroke, with no Save button. So two tabs on one
// project overwrite each other in about ninety seconds of ordinary use:
//
//   Open project #142 on the desktop and on the iPad. Correct a size 24 → 36 on
//   the iPad; it PUTs its whole confirmation. Add a $250 rush line on the
//   desktop; it PUTs ITS snapshot — where item 4 is still 24. The size
//   correction is gone, silently, with no conflict and no audit event. 24
//   shirts ship instead of 36.
//
// Each subtree carries its own revision counter. A writer that sends the
// revision it read is only allowed to land on that revision; anything else is a
// 409 the client can resolve. A writer that sends nothing gets exactly today's
// behaviour, so the agent portal, the scripts and the apps-script integration
// are untouched — this is opt-in per request, not a new protocol.
//
// Per SUBTREE, not per document, deliberately: a background write (the UPS
// tick, a publish, a status change from the board) must never invalidate a
// quote the owner is in the middle of editing. That kind of false conflict is
// how a guard like this gets switched off.
const GUARDED = [
  { field: 'confirmation', rev: 'confirmationRev', base: 'baseConfirmationRev' },
  { field: 'quoteLines',   rev: 'quoteLinesRev',   base: 'baseQuoteLinesRev' },
];

// Reads (and REMOVES) the control fields from an update body, returning the
// filter conditions and the counter bumps that body implies.
//
// Mutates `body` on purpose: the base revisions are protocol, not data, and
// must never reach `$set` — and neither may a client-supplied counter, or a
// stale tab could hand itself a free pass by writing its own revision number.
function planRevisionGuard(body) {
  const filter = {};
  const inc = {};
  const bases = {};
  if (!body || typeof body !== 'object') return { filter, inc, bases, guarded: [] };

  const force = body.forceOverwrite === true;
  delete body.forceOverwrite;

  const guarded = [];
  for (const g of GUARDED) {
    const base = body[g.base];
    delete body[g.base];
    delete body[g.rev];                    // never client-writable

    if (!(g.field in body)) continue;      // this write doesn't touch the subtree
    guarded.push(g.field);
    inc[g.rev] = 1;                        // every whole-subtree write is a new revision

    if (force) continue;
    // Revision 0 is a REAL revision — it is what every legacy order reads as —
    // so junk must never coerce into it. `Number('')` and `Number(null)` are
    // both 0, and a client sending an empty base would otherwise get a
    // precondition that looks satisfied and silently overwrites.
    if (base === null || base === undefined || base === '' || typeof base === 'boolean') continue;
    const n = Number(base);
    if (!Number.isInteger(n) || n < 0) continue;   // no usable base → today's behaviour
    bases[g.rev] = n;
    // A document written before these counters existed carries no field at all,
    // which IS revision 0 — `$in: [0, null]` matches both, so nothing needs a
    // backfill and no legacy order conflicts on its first save.
    filter[g.rev] = n === 0 ? { $in: [0, null] } : n;
  }

  return { filter, inc, bases, guarded };
}

// What the client is told when its precondition fails: which subtree moved, and
// what the revisions are now, so it can re-read and retry without guessing.
function conflictPayload(current, bases) {
  const revs = {
    confirmationRev: Number((current && current.confirmationRev) || 0),
    quoteLinesRev: Number((current && current.quoteLinesRev) || 0),
  };
  const conflicted = Object.keys(bases || {}).filter((k) => revs[k] !== bases[k]);
  return {
    message: 'This project changed somewhere else while you were editing it.',
    reason: 'conflict',
    conflicted,
    revs,
  };
}

module.exports = { planRevisionGuard, conflictPayload, GUARDED };
