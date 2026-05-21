// services/ssWarmAll.js
//
// PER-STYLE WARM IS DISABLED.
//
// We discovered via the /api/products/ss/debug endpoint that S&S's
// /v2/products/ endpoint returns 404 for our account — every per-style
// SKU fetch fails. The /v2/styles/ endpoint works fine, so the catalog,
// detail pages, and admin lookups all run off /styles/ data only.
//
// This stub stays so existing server.js / route handlers that require
// './services/ssWarmAll' keep working. The exported function is a
// no-op that returns immediately.
//
// If S&S ever unlocks /products/ for our account, this file can be
// restored from git history (commit 31dcefa) and the controller's
// syncSingleStyle path will start working again.

async function warmAllStyles() {
  console.log('[warmAll] disabled (S&S /products/ unavailable for this account).');
}

module.exports = { warmAllStyles };
