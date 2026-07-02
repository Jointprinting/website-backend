// Backup / restore — full-site snapshots so the user can keep weekly
// archives on a hard drive and recover from a wipe. Everything that
// matters goes into a single ZIP: per-collection JSON files plus the
// uploads directory plus EVERY image stored in Cloudflare R2 — receipts
// AND the studio composites (mockup/blank/logo thumbnails + data, version
// thumbnails) — so even a total R2 loss can't take the only copy.
//
// EVERY collection is captured. Rather than a hand-maintained list (which
// silently dropped Vendor / PurchaseOrder / Counter when those models were
// added), the set of collections is derived at runtime from
// mongoose.modelNames(), minus a small, explicit skip-set of transient /
// machine-local state. A model added in the future is therefore backed up
// automatically with no code change here — see getBackupModels().

const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');
// archiver@8 ships as ESM-only and dropped the callable factory. The base
// Archiver class doesn't wire up the zip format module on its own — you
// have to pick a format-specific subclass (ZipArchive / TarArchive /
// JsonArchive) so `_module` and `_format` are populated. Calling
// `new Archiver('zip', ...)` looked right but blew up at queue-flush time
// with "this._module.append is not a function".
const { ZipArchive } = require('archiver');
const unzipper = require('unzipper');

const r2 = require('../services/r2');
const BackupLog = require('../models/BackupLog');

// Collections intentionally EXCLUDED from a backup. These are transient
// rate-limit counters, ephemeral scheduler state, short-lived caches, OAuth
// tokens that must not move between environments, or the backup log itself —
// all either reconstructable or actively harmful to carry across a restore.
// Anything NOT in this set is backed up, so a newly-added business model is
// captured automatically.
const SKIP_COLLECTIONS = new Set([
  'BackupLog',              // the log of backups — would create confusing self-reference
  'GoogleDriveAuth',        // OAuth refresh token — environment-specific, re-obtained by reconnecting
  'JpwApiUsage',            // transient API rate-limit accounting
  'JpwSchedulerState',      // ephemeral scheduler bookkeeping
  'JpwSweepPairHistory',    // transient sweep dedupe history
]);

// The models that go in a backup: every registered Mongoose model except the
// skip-set, sorted by name for a deterministic, diff-friendly manifest. Derived
// fresh each call so models registered after boot are still included.
//
// `extraSkip` lets tests (and only tests) narrow the set; production always
// passes nothing.
function getBackupModels(extraSkip = null) {
  const skip = extraSkip || SKIP_COLLECTIONS;
  return mongoose.modelNames()
    .filter((name) => !skip.has(name))
    .sort()
    .map((name) => ({ name, Model: mongoose.model(name) }));
}

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
// Manual hard-drive backups only need to be monthly now that Google Drive
// auto-pushes a full copy every week — this is just the third, offline safety net.
const BACKUP_DUE_DAYS = 30;

// Bumped to 3: the manifest now carries per-collection counts and the model set
// is enumerated dynamically. v2 archives still restore fine (counts are optional
// on read), so this is backward-compatible.
const SCHEMA_VERSION = 3;

// Friendly, sortable archive name, e.g. "Joint Printing Backup 2026-06-22 1734.zip".
function backupFileName() {
  const iso = new Date().toISOString();
  return `Joint Printing Backup ${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}.zip`;
}

// Reverse of r2's EXT_BY_MIME, for restoring receipt files with a sensible
// Content-Type so the browser renders them inline instead of downloading.
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', heic: 'image/heic', pdf: 'application/pdf',
};

// ── Pure helpers (unit-tested without a DB) ──────────────────────────────────

// The manifest written into every archive. `counts` is { CollectionName: n }.
function buildManifest(modelNames, counts) {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    app: 'joint-printing',
    collections: [...modelNames],
    counts: { ...counts },
  };
}

// Validate a parsed archive BEFORE any database write. Returns nothing on
// success; THROWS a clear, user-facing error on anything wrong. This is the
// gate that makes a restore safe: a foreign / truncated / hand-edited file is
// rejected here, with the database still fully intact.
//
//   manifest   – the parsed manifest.json object (or null if missing)
//   dataNames  – the collection names present as data/<name>.json in the archive
//   knownNames – the set of collection names this server recognizes
function validateArchive(manifest, dataNames, knownNames) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Not a Joint Printing backup: manifest.json is missing or unreadable. Refusing to touch the database.');
  }
  if (!Array.isArray(manifest.collections)) {
    throw new Error('Backup manifest is malformed (no collections list). Refusing to restore.');
  }
  if (manifest.app && manifest.app !== 'joint-printing') {
    throw new Error(`This backup is for "${manifest.app}", not Joint Printing. Refusing to restore.`);
  }
  if (!dataNames || dataNames.length === 0) {
    throw new Error('Backup contains no collection data (no data/*.json). Refusing to restore.');
  }
  // Every data file must be a collection this server knows about. An unknown
  // collection means a wrong/foreign archive or a schema this code can't map —
  // safer to refuse than to silently drop it.
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames);
  const unknown = dataNames.filter((n) => !known.has(n));
  if (unknown.length) {
    throw new Error(`Backup references unknown collections: ${unknown.join(', ')}. Wrong file, or made by a newer version. Refusing to restore.`);
  }
}

// Reject any document set that can't be restored safely BEFORE a single write
// happens. Two guards, both data-loss preventers:
//   • every doc must carry an _id — an _id-less doc would upsert onto a shared
//     `{_id: null}` row, silently collapsing many docs into one.
//   • no two docs in a collection may share an _id — a within-collection
//     duplicate would make the upsert non-deterministic (and break replace's
//     insertMany with a duplicate-key error mid-loop).
// Throws a clear error (DB untouched) on violation; returns nothing on success.
function assertRestorableDocs(name, docs) {
  const seen = new Set();
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!d || typeof d !== 'object') {
      throw new Error(`${name}.json[${i}] is not an object. Refusing to restore.`);
    }
    if (d._id === undefined || d._id === null || d._id === '') {
      throw new Error(`${name}.json[${i}] has no _id. A backup must identify every record — refusing to restore.`);
    }
    const key = String(d._id);
    if (seen.has(key)) {
      throw new Error(`${name}.json has two records with _id ${key}. Corrupt archive — refusing to restore.`);
    }
    seen.add(key);
  }
}

// Mongo's _id arrives from JSON as a plain string/number; cast it back to an
// ObjectId when it looks like one so upsert-by-_id matches the existing doc
// (and re-importing the same backup is a true no-op).
function reviveId(id) {
  if (typeof id === 'string' && mongoose.isObjectIdOrHexString(id) && id.length === 24) {
    return new mongoose.Types.ObjectId(id);
  }
  return id;
}

// Turn an array of plain documents into bulkWrite replaceOne-upsert ops keyed by
// _id. Idempotent: importing the same docs twice yields identical data, and
// nothing is ever deleted in this (default) mode.
function upsertOps(docs) {
  return docs.map((doc) => {
    const _id = reviveId(doc._id);
    return { replaceOne: { filter: { _id }, replacement: { ...doc, _id }, upsert: true } };
  });
}

// ── Archive assembly ─────────────────────────────────────────────────────────

// Deep-walk a (lean) document collecting EVERY Cloudflare R2 URL it references in any
// string field — at any depth, including inside a Mixed `pageState`. The image bytes
// live in R2, not Mongo, so the JSON dumps alone would leave them out of the backup;
// this pulls the actual bytes into the archive so a total R2 loss can't take the only
// copy. Field-agnostic ON PURPOSE: it catches receiptUrl/fileUrl on the ledger AND the
// studio composites (StudioLibraryItem + StudioMockupVersion `thumbnail`/`data`) — and
// any R2-backed field added in the future — with no code change here. Mirrors
// getBackupModels()'s "derive it, don't hand-maintain a list" philosophy.
function addR2UrlsFromValue(val, urls) {
  if (typeof val === 'string') { if (r2.isR2Url(val)) urls.add(val); return; }
  if (Array.isArray(val)) { for (const v of val) addR2UrlsFromValue(v, urls); return; }
  if (val && typeof val === 'object') { for (const k of Object.keys(val)) addR2UrlsFromValue(val[k], urls); }
}

// Append the full backup payload (manifest + per-collection JSON + uploaded
// files + R2 receipt images) to an already-piped archive. Shared by the HTTP
// download (exportAll) and the Google Drive push (writeBackupToFile) so both
// produce an identical, complete archive. Returns counts for the BackupLog.
async function appendBackupContents(archive) {
  const models = getBackupModels();
  const counts = {};
  let totalDocs = 0, fileCount = 0, r2Count = 0, r2Missing = 0;

  // Per-collection JSON dumps (counts gathered first so the manifest can record them).
  // While we already hold each collection's docs, deep-scan them for R2 image URLs — no
  // second pass over the database.
  const dumps = [];
  const r2Urls = new Set();
  const wantR2 = r2.isR2Configured();
  for (const { name, Model } of models) {
    const docs = await Model.find({}).lean();
    counts[name] = docs.length;
    totalDocs += docs.length;
    if (wantR2) for (const d of docs) addR2UrlsFromValue(d, r2Urls);
    dumps.push({ name, json: JSON.stringify(docs, null, 2) });
  }

  // Manifest first (now includes per-collection counts, so a restore can verify)
  archive.append(JSON.stringify(buildManifest(models.map((m) => m.name), counts), null, 2),
    { name: 'manifest.json' });
  for (const { name, json } of dumps) archive.append(json, { name: `data/${name}.json` });

  // Uploaded files (project attachments stored on local disk)
  if (fs.existsSync(UPLOADS_DIR)) {
    for (const entry of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, entry);
      try {
        if (fs.statSync(p).isFile()) { archive.file(p, { name: `files/${entry}` }); fileCount++; }
      } catch (_) { /* skip */ }
    }
  }

  // Every R2 image (receipts AND studio composites), keyed by its object key so a
  // restore can re-upload to the exact same key (preserving every stored URL). Gathered
  // above during the dump pass.
  if (wantR2) {
    for (const url of r2Urls) {
      const key = r2.keyFromUrl(url);
      if (!key) continue;
      const buf = await r2.getBufferByUrl(url);
      if (!buf) { r2Missing++; continue; }       // object missing/unreadable — skip, don't abort
      archive.append(buf, { name: `r2/${key}` });
      r2Count++;
    }
  }

  return { counts, totalDocs, fileCount, r2Count, r2Missing };
}

// Build a complete backup ZIP to a file on disk and resolve with its stats.
// Used by the Google Drive auto-push, which needs the finished bytes to upload
// (unlike the HTTP export, which streams straight to the response).
function writeBackupToFile(filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    let bytes = 0, stats = null;
    archive.on('data', (c) => { bytes += c.length; });
    archive.on('warning', (e) => console.warn('archive warning:', e));
    archive.on('error', reject);
    out.on('error', reject);
    out.on('close', () => resolve({ ...(stats || {}), sizeBytes: bytes }));
    archive.pipe(out);
    appendBackupContents(archive)
      .then((s) => { stats = s; return archive.finalize(); })
      .catch(reject);
  });
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

// GET /api/admin/backup/status
const status = async (req, res) => {
  try {
    const last = await BackupLog.findOne({ kind: 'export', status: 'ok' }).sort({ at: -1 }).lean();
    const lastImport = await BackupLog.findOne({ kind: 'import', status: 'ok' }).sort({ at: -1 }).lean();
    const lastAt  = last ? last.at : null;
    const days = lastAt ? Math.floor((Date.now() - new Date(lastAt).getTime()) / (24*60*60*1000)) : null;
    const isDue = days === null || days >= BACKUP_DUE_DAYS;
    res.json({
      lastBackupAt: lastAt,
      lastBackupDays: days,
      isDue, dueAfterDays: BACKUP_DUE_DAYS,
      lastImportAt: lastImport ? lastImport.at : null,
      collections: last ? last.collections : null,
      // So the UI can show exactly what WILL be captured, even before the first export.
      backedUpCollections: getBackupModels().map((m) => m.name),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/admin/backup/export — streams a ZIP archive
const exportAll = async (req, res) => {
  const startedAt = Date.now();
  const filename = backupFileName();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  let bytes = 0;

  archive.on('data', (chunk) => { bytes += chunk.length; });
  archive.on('warning', (err) => console.warn('archive warning:', err));
  archive.on('error', (err) => {
    console.error('archive error:', err);
    try { res.status(500).end(); } catch (_) {}
  });

  archive.pipe(res);

  try {
    const { counts, totalDocs, fileCount, r2Count, r2Missing } = await appendBackupContents(archive);
    await archive.finalize();

    // Log success after the stream is fully sent
    res.on('finish', async () => {
      try {
        await BackupLog.create({
          kind: 'export', status: 'ok',
          collections: counts, totalDocs, fileCount: fileCount + r2Count, sizeBytes: bytes,
          note: `Took ${Math.round((Date.now() - startedAt) / 1000)}s` +
            (r2Count ? `; ${r2Count} receipt files` : '') +
            (r2Missing ? `; ${r2Missing} R2 files missing` : ''),
        });
      } catch (e) { console.warn('BackupLog write failed', e.message); }
    });
  } catch (e) {
    console.error('export failed', e);
    try {
      await BackupLog.create({ kind: 'export', status: 'failed', note: e.message });
    } catch (_) {}
    if (!res.headersSent) res.status(500).json({ message: e.message });
  }
};

// Read + parse + VALIDATE an opened archive. Returns
// { manifest, prepared: [{ name, Model, docs }], dataNames } with the database
// untouched. Throws (DB intact) on anything malformed. Shared so the validation
// path is identical for every restore mode.
async function readAndValidateArchive(directory) {
  const manifestEntry = directory.files.find((f) => f.path === 'manifest.json');
  const manifest = manifestEntry
    ? JSON.parse((await manifestEntry.buffer()).toString('utf-8'))
    : null;

  const models = getBackupModels();
  const byName = new Map(models.map((m) => [m.name, m.Model]));
  const knownNames = new Set(models.map((m) => m.name));

  // Which collections does the archive actually carry data for?
  const dataNames = directory.files
    .filter((f) => /^data\/[^/]+\.json$/.test(f.path) && f.type === 'File')
    .map((f) => f.path.slice('data/'.length, -'.json'.length));

  validateArchive(manifest, dataNames, knownNames);

  // Parse + type-check + validate EVERY collection JSON before returning, so the
  // caller can apply with confidence that nothing in the archive will blow up
  // mid-write. This is what keeps a destructive `replace` crash-safe: by the
  // time the first deleteMany runs, every document of every collection has
  // already passed structure, _id, and (for real models) schema validation —
  // so the apply loop can't throw partway and leave the DB half-wiped.
  const prepared = [];
  for (const name of dataNames) {
    const file = directory.files.find((f) => f.path === `data/${name}.json`);
    const json = (await file.buffer()).toString('utf-8');
    let docs;
    try { docs = JSON.parse(json); } catch (e) {
      throw new Error(`${name}.json is not valid JSON: ${e.message}. Refusing to restore.`);
    }
    if (!Array.isArray(docs)) throw new Error(`${name}.json is not an array. Refusing to restore.`);
    assertRestorableDocs(name, docs);             // _id present + unique
    dryValidateDocs(byName.get(name), name, docs); // schema check (real models only)
    prepared.push({ name, Model: byName.get(name), docs });
  }
  return { manifest, prepared, dataNames };
}

// Dry-run schema validation: hydrate each doc through the model and validate it
// WITHOUT writing, so a schema/enum/required violation is caught up front rather
// than mid-restore. No-ops for the lightweight fakes used in unit tests (which
// don't expose a Mongoose schema). Best-effort and tolerant: a doc the current
// schema can't construct at all (older shape) is skipped rather than rejected,
// since restore must be able to bring back legacy data — the goal here is only
// to stop a write-time throw from partial-wiping in replace mode.
function dryValidateDocs(Model, name, docs) {
  if (!Model || !Model.schema || typeof Model.hydrate !== 'function') return; // not a real Mongoose model
  for (let i = 0; i < docs.length; i++) {
    let doc;
    try { doc = new Model({ ...docs[i], _id: reviveId(docs[i]._id) }); }
    catch (_) { continue; }  // can't even construct it — leave it for the insert/upsert to handle
    const err = typeof doc.validateSync === 'function' ? doc.validateSync() : null;
    if (err) {
      throw new Error(`${name}.json[${i}] fails validation: ${err.message}. Refusing to restore.`);
    }
  }
}

// Apply a prepared, already-validated restore.
//   mode 'merge'   (default) — upsert by _id; never deletes. Idempotent. The
//                  archive has been fully parsed/validated already, so this
//                  path cannot partial-wipe: it only ever adds/overwrites.
//   mode 'replace'           — wipe each collection then insert (full replace).
//                  Opt-in + typed-confirmation only (see restoreAll). Because a
//                  standalone Mongo can't span a multi-collection transaction,
//                  a write error on collection N would leave earlier collections
//                  replaced and N empty — which is why replace is gated and the
//                  SAFE merge is the default. The up-front validation still rules
//                  out malformed input as a trigger.
// Returns { counts, totalDocs }.
async function applyRestore(prepared, mode) {
  const counts = {};
  let totalDocs = 0;
  for (const { name, Model, docs } of prepared) {
    if (mode === 'replace') {
      await Model.deleteMany({});
      for (let i = 0; i < docs.length; i += 500) {
        const slice = docs.slice(i, i + 500).map((d) => ({ ...d, _id: reviveId(d._id) }));
        if (slice.length) await Model.insertMany(slice, { ordered: false });
      }
    } else {
      const ops = upsertOps(docs);
      for (let i = 0; i < ops.length; i += 500) {
        await Model.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      }
    }
    counts[name] = docs.length;
    totalDocs += docs.length;
  }
  return { counts, totalDocs };
}

// POST /api/admin/backup/restore — body: multipart/form-data with file=<zip>
// Query/body options:
//   mode=replace + confirm=REPLACE  → destructive full replace (otherwise: safe merge/upsert).
const restoreAll = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No backup file provided' });
  const startedAt = Date.now();

  // Default is the SAFE, idempotent merge. The destructive replace must be asked
  // for explicitly AND confirmed, so a stray click can never wipe live data.
  const wantReplace = (req.query.mode || req.body.mode) === 'replace';
  const confirmed   = (req.query.confirm || req.body.confirm) === 'REPLACE';
  const mode = wantReplace ? 'replace' : 'merge';
  if (wantReplace && !confirmed) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({
      message: 'Destructive replace requires confirm=REPLACE. Aborting — no data changed.',
    });
  }

  let fileCount = 0;
  try {
    const buf = fs.readFileSync(req.file.path);
    const directory = await unzipper.Open.buffer(buf);

    // SAFETY: parse + validate the WHOLE archive before any DB write. A corrupt
    // or foreign file aborts here with the database completely intact — the bug
    // that earlier delete-then-insert loops could leave half the DB wiped.
    const { prepared } = await readAndValidateArchive(directory);

    const { counts, totalDocs } = await applyRestore(prepared, mode);

    // Restore uploaded files
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    for (const file of directory.files) {
      if (!file.path.startsWith('files/') || file.type !== 'File') continue;
      const rel = file.path.replace(/^files\//, '');
      if (!rel || rel.includes('..') || rel.includes('/')) continue;  // ignore subdirs or traversal
      const dest = path.join(UPLOADS_DIR, rel);
      fs.writeFileSync(dest, await file.buffer());
      fileCount++;
    }

    // Restore R2 receipt images by re-uploading each to its ORIGINAL key, so
    // every receiptUrl/fileUrl already in the restored documents keeps working.
    // Skipped silently if R2 isn't configured on this environment.
    let r2Count = 0;
    if (r2.isR2Configured()) {
      for (const file of directory.files) {
        if (!file.path.startsWith('r2/') || file.type !== 'File') continue;
        const key = file.path.replace(/^r2\//, '');
        if (!key || key.includes('..')) continue;
        const ext = key.split('.').pop().toLowerCase();
        try {
          await r2.uploadToKey(key, await file.buffer(), MIME_BY_EXT[ext] || 'application/octet-stream');
          r2Count++;
        } catch (e) { console.warn('R2 restore failed for', key, e.message); }
      }
    }
    fileCount += r2Count;

    try { fs.unlinkSync(req.file.path); } catch (_) {}

    await BackupLog.create({
      kind: 'import', status: 'ok',
      collections: counts, totalDocs, fileCount,
      note: `Restored (${mode}) in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    });

    res.json({ ok: true, mode, collections: counts, totalDocs, fileCount });
  } catch (e) {
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {}
    try {
      await BackupLog.create({ kind: 'import', status: 'failed', note: e.message });
    } catch (_) {}
    res.status(400).json({ message: e.message });
  }
};

module.exports = {
  status, exportAll, restoreAll, writeBackupToFile, backupFileName,
  // exported for tests + the Drive push / status surface
  getBackupModels, buildManifest, validateArchive, upsertOps, reviveId,
  assertRestorableDocs, dryValidateDocs,
  readAndValidateArchive, applyRestore, SKIP_COLLECTIONS, SCHEMA_VERSION,
};
