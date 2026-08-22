// utils/safeFetch.js
//
// Fetching a URL THE APP DID NOT CHOOSE.
//
// Several places here fetch a URL that ultimately came from outside: a company
// website scraped off OpenStreetMap (services/emailEnricher), a site being
// audited (services/jpwAuditor), an image referenced by a document
// (utils/pdfImage). Overpass in particular is a public wiki — anyone can edit a
// `website=` tag on a node.
//
// Fetched from inside the API host, a URL like http://169.254.169.254/... or
// http://localhost:27017 reaches things the public internet cannot. The
// enricher then REGEXES THE RESPONSE BODY FOR EMAILS and shows the outcome in
// the Studio, which turns an ordinary scrape into a clean read oracle for the
// host's own network.
//
// So: an allowlist of schemes, a block on private / loopback / link-local
// destinations, and — the part that is easy to miss — the same check applied on
// EVERY REDIRECT HOP. Validating only the first URL is no protection at all,
// because the attacker controls the server that issues the 302.
//
// Pure and dependency-light so it can be unit-tested without a network.

const dns = require('dns').promises;
const net = require('net');

// http(s) only. A `file://` fetch reads the container's disk; `gopher://` and
// friends have historically been protocol-smuggling vectors.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// PURE — exported for tests.
//
// Ranges that are never a legitimate destination for one of these fetches.
// Written out rather than pulled from a package so the reasoning is auditable
// and it cannot change under us.
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = p;
  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // RFC1918
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local — the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true;         // RFC1918
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                       // multicast + reserved
  return false;
}

// PURE — exported for tests.
function isPrivateIPv6(ip) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;      // loopback / unspecified
  if (s.startsWith('fe80')) return true;           // link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local
  // An IPv4-mapped address (::ffff:169.254.169.254) reaches exactly the same
  // place as the bare IPv4 would.
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

// PURE — exported for tests.
function isPrivateAddress(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  // Names that resolve to the host itself without needing DNS.
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) return isPrivateIPv4(h);
  if (net.isIPv6(h)) return isPrivateIPv6(h);
  return false;
}

// PURE — exported for tests. Returns { ok, reason } for a URL STRING, before any
// DNS. `ok:false` means never fetch it.
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); }
  catch { return { ok: false, reason: 'not-a-url' }; }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) return { ok: false, reason: `blocked-scheme:${u.protocol}` };
  // Credentials in a URL are a redirect-laundering trick and never appear in a
  // legitimate company website link.
  if (u.username || u.password) return { ok: false, reason: 'credentials-in-url' };
  if (isPrivateAddress(u.hostname)) return { ok: false, reason: 'private-address' };
  return { ok: true, url: u };
}

// The DNS half. A hostname that LOOKS public can still resolve to 127.0.0.1 —
// which is the whole trick — so the name is resolved and every answer checked.
async function resolvesPublic(hostname) {
  if (net.isIP(hostname)) return !isPrivateAddress(hostname);
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    return false;   // can't resolve it → don't fetch it
  }
  if (!addrs.length) return false;
  return addrs.every((a) => !isPrivateAddress(a.address));
}

// Is this URL safe to fetch? Async because of the DNS check.
async function isSafeUrl(raw) {
  const pre = checkUrl(raw);
  if (!pre.ok) return pre;
  const ok = await resolvesPublic(pre.url.hostname);
  return ok ? { ok: true, url: pre.url } : { ok: false, reason: 'resolves-private' };
}

// A safe GET, built on the caller's own axios instance so timeouts, size caps,
// user-agent and response handling stay exactly as each caller had them.
//
// Redirects are followed MANUALLY — `maxRedirects: 0` — because that is the only
// way to re-check each hop. axios following them internally would validate the
// first URL and then happily chase a 302 to the metadata endpoint.
async function safeGet(axios, url, options = {}, { maxRedirects = 5 } = {}) {
  let current = String(url || '');
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = await isSafeUrl(current);
    if (!check.ok) {
      const err = new Error(`Refused to fetch ${current} (${check.reason})`);
      err.code = 'UNSAFE_URL';
      err.reason = check.reason;
      throw err;
    }
    const res = await axios.get(current, {
      ...options,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    const status = Number(res.status) || 0;
    const location = res.headers && (res.headers.location || res.headers.Location);
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  const err = new Error(`Too many redirects fetching ${url}`);
  err.code = 'TOO_MANY_REDIRECTS';
  throw err;
}

module.exports = {
  safeGet, isSafeUrl,
  // PURE (no DNS, no network) — exported for tests.
  checkUrl, isPrivateAddress, isPrivateIPv4, isPrivateIPv6, ALLOWED_PROTOCOLS,
};
