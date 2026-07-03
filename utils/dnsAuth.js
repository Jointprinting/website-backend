// utils/dnsAuth.js
//
// Email-authentication preflight for the cold-outreach sender — the single
// biggest inbox-vs-spam lever after content. As of the 2024 Gmail/Yahoo
// bulk-sender rules, a sending domain needs SPF + DKIM aligned and a published
// DMARC record or its mail gets junked or rejected outright.
//
// This resolves the sender domain's DNS and classifies its posture red/amber/
// green so the Studio can surface it and the engine can HOLD sends when the
// essentials (SPF + DMARC) are missing — the same "don't send blind" guard the
// engine already applies when OUTREACH_EMAIL_FROM is unset.
//
// classifyAuth() is PURE (unit-tested); checkDomainAuth() does the async
// resolution; getAuthStatus() caches it (DNS shouldn't run every dashboard load).

const dns = require('dns').promises;

const domainOf = (addr) => {
  const s = String(addr || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  const host = at >= 0 ? s.slice(at + 1) : s;
  return host.replace(/[>\s]+$/, '');
};

// Pure classifier: given what resolved, decide the posture + a short reason list.
//   green  — SPF + DKIM + DMARC present and DMARC enforcing (p != none)
//   amber  — has the essentials (SPF + DMARC) but DKIM unseen or DMARC p=none
//   red    — missing SPF or DMARC (the two Gmail/Yahoo hard requirements)
//   unknown — DNS couldn't be reached (never gate on this — could be transient)
function classifyAuth({ domain = '', reachable = true, spf = false, dkim = false, dmarc = false, dmarcPolicy = '' } = {}) {
  if (!domain) return { level: 'unknown', domain: '', spf, dkim, dmarc, dmarcPolicy, gateOk: true, issues: ['No sender domain set.'] };
  if (!reachable) return { level: 'unknown', domain, spf, dkim, dmarc, dmarcPolicy, gateOk: true, issues: ['DNS lookup unavailable — auth not verified.'] };

  const issues = [];
  if (!spf) issues.push('No SPF record (v=spf1) — add your SMTP provider’s include.');
  if (!dmarc) issues.push('No DMARC record at _dmarc — publish at least p=none.');
  if (!dkim) issues.push('No DKIM selector resolved — publish your provider’s DKIM CNAMEs (or set OUTREACH_DKIM_SELECTOR).');
  if (dmarc && dmarcPolicy === 'none') issues.push('DMARC is p=none (monitor only) — move to quarantine once clean.');

  let level;
  if (!spf || !dmarc) level = 'red';
  else if (!dkim || dmarcPolicy === 'none') level = 'amber';
  else level = 'green';

  // Gate (may we send?) — hold only on a confirmed red (missing SPF/DMARC).
  const gateOk = level !== 'red';
  return { level, domain, spf, dkim, dmarc, dmarcPolicy, gateOk, issues };
}

async function resolveTxt(name) {
  try { return (await dns.resolveTxt(name)).map((chunks) => chunks.join('')); }
  catch { return null; } // null = lookup error/NXDOMAIN (caller treats absent)
}
async function resolveCname(name) {
  try { return await dns.resolveCname(name); }
  catch { return null; }
}

// Common DKIM selectors to probe when one isn't configured (providers differ).
const DKIM_SELECTORS = ['default', 'sp', 's1', 's2', 'k1', 'k2', 'sendpulse', 'mail', 'google', 'selector1', 'selector2', 'dkim', 'mandrill'];

// Resolve + classify a sending domain's email auth. Best-effort; never throws.
async function checkDomainAuth(domain, opts = {}) {
  const dom = domainOf(domain);
  if (!dom) return classifyAuth({ domain: '' });

  // Reachability probe — if the domain's NS can't be resolved at all, treat the
  // whole check as 'unknown' so a transient DNS failure never falsely holds sends.
  let reachable = true;
  try { await dns.resolveNs(dom); } catch {
    // NS can fail for subdomains that still have TXT; fall back to a TXT probe.
    const t = await resolveTxt(dom);
    reachable = t !== null;
  }

  const spfTxts = (await resolveTxt(dom)) || [];
  const spf = spfTxts.some((t) => /^v=spf1/i.test(t));

  const dmarcTxts = (await resolveTxt(`_dmarc.${dom}`)) || [];
  const dmarcRec = dmarcTxts.find((t) => /^v=DMARC1/i.test(t)) || '';
  const dmarc = !!dmarcRec;
  const dmarcPolicy = ((dmarcRec.match(/\bp\s*=\s*(\w+)/i) || [])[1] || '').toLowerCase();

  const selectors = (opts.selector ? [String(opts.selector)] : []).concat(DKIM_SELECTORS);
  let dkim = false;
  let dkimSelector = '';
  for (const sel of selectors) {
    const host = `${sel}._domainkey.${dom}`;
    const [t, c] = await Promise.all([resolveTxt(host), resolveCname(host)]);
    if ((t && t.some((x) => /v=DKIM1|k=rsa|p=[A-Za-z0-9]/i.test(x))) || (c && c.length)) { dkim = true; dkimSelector = sel; break; }
  }

  return { ...classifyAuth({ domain: dom, reachable, spf, dkim, dmarc, dmarcPolicy }), dkimSelector };
}

// Cached wrapper — DNS shouldn't run on every dashboard load or engine tick.
// Caches per-domain for CACHE_MS (default 1h); force:true bypasses.
const _cache = new Map(); // domain → { at, result }
const CACHE_MS = parseInt(process.env.OUTREACH_AUTH_CACHE_MS || String(60 * 60 * 1000), 10);

async function getAuthStatus(fromAddress, { now = Date.now(), force = false, selector } = {}) {
  const dom = domainOf(fromAddress);
  if (!dom) return classifyAuth({ domain: '' });
  const hit = _cache.get(dom);
  if (!force && hit && (now - hit.at) < CACHE_MS) return hit.result;
  const result = await checkDomainAuth(dom, { selector: selector || process.env.OUTREACH_DKIM_SELECTOR });
  _cache.set(dom, { at: now, result });
  return result;
}

module.exports = { classifyAuth, checkDomainAuth, getAuthStatus, domainOf };
