// services/r2.js
//
// Thin wrapper around Cloudflare R2 (S3-compatible object storage) for image
// hosting. Images used to be stored as base64 text inside MongoDB documents,
// which blew past Mongo's 16MB-per-doc ceiling (breaking the client approval
// link past a handful of images) and bloated every read. We now offload them
// to R2 and store only the public URL in the document.
//
// Feature-flagged: if the R2_* env vars aren't set, isR2Configured() returns
// false and callers keep the legacy base64 behavior — so nothing changes until
// the bucket + keys are in place. The AWS SDK is lazy-required so a server
// without the dependency installed (or without R2 configured) still boots.

const crypto = require('crypto');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE_URL,
} = process.env;

function isR2Configured() {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_BASE_URL);
}

const _base = () => String(R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

let _client = null;
function _getClient() {
  if (_client) return _client;
  const { S3Client } = require('@aws-sdk/client-s3'); // lazy — only loaded when R2 is actually used
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return _client;
}

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'image/heic': 'heic', 'application/pdf': 'pdf',
};

function _publicUrl(key) {
  return `${_base()}/${key}`;
}

// Parse a data URL → { contentType, buffer } or null if it isn't a base64 data URL.
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) return null;
  try { return { contentType: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') }; }
  catch (_) { return null; }
}

// True if the string is one of our hosted R2 URLs (so we don't re-upload it).
function isR2Url(s) {
  return typeof s === 'string' && !!R2_PUBLIC_BASE_URL && s.startsWith(_base() + '/');
}

// Upload a raw buffer; returns the public URL. Keys are unguessable UUIDs and
// objects are served with a long immutable cache header (content never changes
// under a given key — we always write a new key).
async function uploadBuffer(buffer, contentType, keyPrefix = 'misc') {
  if (!isR2Configured()) throw new Error('R2 not configured');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const ext = EXT_BY_MIME[(contentType || '').toLowerCase()] || 'bin';
  const key = `${keyPrefix}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  await _getClient().send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return _publicUrl(key);
}

// Upload a base64 data URL and return its public URL. If the value isn't a
// base64 data URL (already an http URL, empty, or null), it's returned
// unchanged — so callers can pass field values blindly during migration.
async function uploadDataUrl(maybeDataUrl, keyPrefix = 'misc') {
  const parsed = parseDataUrl(maybeDataUrl);
  if (!parsed) return maybeDataUrl;
  return uploadBuffer(parsed.buffer, parsed.contentType, keyPrefix);
}

// The object key for one of our public URLs (the part after the base), or null
// if the string isn't one of our R2 URLs. Keys are stable, so re-uploading to
// the same key reproduces the same public URL — which is what lets a backup
// capture the bytes and a restore put them back without rewriting references.
function keyFromUrl(url) {
  if (!isR2Url(url)) return null;
  return url.slice((_base() + '/').length);
}

// Fetch the raw bytes of an object addressed by its public URL. Returns a
// Buffer, or null if R2 isn't configured / the URL isn't ours / the object is
// gone. Used by the backup export to pull receipt images out of R2 and into the
// archive so a Cloudflare/R2 outage doesn't take the only copy with it.
async function getBufferByUrl(url) {
  const key = keyFromUrl(url);
  if (!key) return null;
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const out = await _getClient().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (_) { return null; }
}

// Upload a buffer to an EXACT key (not a generated one). Used by restore to put
// archived receipt files back where their stored URLs already point.
async function uploadToKey(key, buffer, contentType) {
  if (!isR2Configured()) throw new Error('R2 not configured');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await _getClient().send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return _publicUrl(key);
}

// Best-effort delete of a previously-uploaded object, addressed by its public
// URL. No-ops for anything that isn't one of our R2 URLs.
async function deleteByUrl(url) {
  if (!isR2Configured() || !isR2Url(url)) return;
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const key = url.slice((_base() + '/').length);
    await _getClient().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (_) { /* best-effort */ }
}

module.exports = {
  isR2Configured, isR2Url, uploadBuffer, uploadDataUrl, deleteByUrl, parseDataUrl,
  keyFromUrl, getBufferByUrl, uploadToKey,
};
