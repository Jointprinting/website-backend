// Soft-delete scoping for models that must NEVER leak an archived (soft-deleted)
// row into a normal read — money (Transaction) and client logos (ClientLogo).
//
// The house rule is "nothing is ever hard-deleted; archive instead" (Orders, POs,
// Vendors, Clients, Deals … all carry `archived`). Those models filter `archived:
// { $ne: true }` at each read site. Transaction has ~30 read sites across a dozen
// controllers (P&L, per-order margin, exports, dedupe, reconcile, receipts, signals,
// CRM), and ClientLogo is read from six client-facing surfaces — hand-filtering every
// one is how a single missed site silently resurrects a "deleted" payment in the P&L.
//
// So these two models install a Mongoose query guard that injects the not-archived
// condition automatically on every find/aggregate, unless the caller (a) already
// constrained `archived` itself (a future trash/restore view) or (b) opts in with
// `{ withArchived: true }` (the upsert/revive paths that must reach an archived doc
// to bring it back). Keeping the merge logic here — pure, no DB — makes the "archived
// rows never leak" contract unit-testable and identical across both models.

const LIVE_MATCH = { archived: { $ne: true } };
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// Merge the not-archived guard into a find/update filter. Left untouched when the
// caller already mentions `archived` (explicit trash query) or passed withArchived.
function scopeLiveFilter(filter = {}, opts = {}) {
  if (opts && opts.withArchived) return filter;
  if (has(filter, 'archived')) return filter;
  return { ...filter, ...LIVE_MATCH };
}

// Prepend a not-archived $match to an aggregate pipeline under the same rules. A
// pipeline that already leads with an `archived` $match (or opts in) is left as-is.
function scopeLivePipeline(pipeline = [], opts = {}) {
  if (opts && opts.withArchived) return pipeline.slice();
  const first = pipeline[0] && pipeline[0].$match;
  if (first && has(first, 'archived')) return pipeline.slice();
  return [{ $match: { ...LIVE_MATCH } }, ...pipeline];
}

// Install the guards on a schema. `find` covers find/findOne/findById and the
// findOneAndUpdate/Delete family (all match /^find/), so an edit can never mutate an
// archived row either; `aggregate` covers the report rollups. deleteMany/updateMany
// are intentionally NOT guarded — they carry explicit filters and are used by the
// archive/restore writes themselves.
function applyLiveScope(schema) {
  schema.pre(/^find/, function scopeFind(next) {
    this.setQuery(scopeLiveFilter(this.getFilter(), this.getOptions()));
    next();
  });
  schema.pre('aggregate', function scopeAggregate(next) {
    const pipe = this.pipeline();
    const scoped = scopeLivePipeline(pipe, this.options || {});
    pipe.splice(0, pipe.length, ...scoped);
    next();
  });
}

module.exports = { LIVE_MATCH, scopeLiveFilter, scopeLivePipeline, applyLiveScope };
