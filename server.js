// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const fs = require('fs');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { roleFrom } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false,
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Vercel gives every preview deployment a fresh hostname per branch/commit, so
// they can't be enumerated in ALLOWED_ORIGINS ahead of time. Accept any preview
// for this project: the hostname always carries our Vercel team slug
// ("joint-printing-front-end"), which is globally unique to us and can't be
// registered by anyone else — so a look-alike origin can't slip through.
// e.g. https://jointprinting-frontend-git-<branch>-joint-printing-front-end.vercel.app
const VERCEL_PREVIEW_ORIGIN =
  /^https:\/\/jointprinting-frontend-[a-z0-9-]+-joint-printing-front-end\.vercel\.app$/;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (VERCEL_PREVIEW_ORIGIN.test(origin)) return cb(null, true);
    // No allowlist configured: open in dev for convenience, but fail CLOSED
    // in production — a missing ALLOWED_ORIGINS must not open the API to
    // every origin on the internet.
    if (allowedOrigins.length === 0) {
      return process.env.NODE_ENV === 'production'
        ? cb(new Error('Not allowed by CORS (no ALLOWED_ORIGINS configured)'))
        : cb(null, true);
    }
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));

// Body parsing. A few routes mount their OWN express.json with a much larger
// limit (receipts 40mb, orders 100mb, crm/finances 8mb, …) registered further
// down. Express runs middleware in registration order and the FIRST json parser
// to touch a request wins (it sets req._body and later parsers no-op), so a
// blanket global parser here would parse — and 413 — every oversized body before
// the per-route limit ever ran (the receipt-scan flow posts ~34MB base64 dataURLs
// and was silently failing as "scan failed"). So the global 1mb fallback SKIPS
// any prefix that brings its own parser; everything else gets the safe default.
const OWN_JSON_PREFIXES = [
  '/api/studio', '/api/site-settings', '/api/orders', '/api/client-logos',
  '/api/clients', '/api/crm', '/api/outreach', '/api/triage', '/api/public',
  '/api/jpw', '/api/gdrive', '/api/finances', '/api/receipts',
];
const globalJson = express.json({ limit: '1mb' });
app.use((req, res, next) => {
  if (OWN_JSON_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  return globalJson(req, res, next);
});
app.use('/api/studio', express.json({ limit: '100mb' }));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename:    (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

// Last-resort net: a single stray rejected promise (e.g. a public webhook that
// awaits Mongo during a blip) must not crash the whole single-dyno API. Log and
// keep serving; the individual handlers still own their own error responses.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
});

// ── Mongo ──
// mongoose does NOT auto-retry the INITIAL connect, and an uncaught rejection
// here would crash-loop the dyno on a transient Atlas blip. Catch + retry with
// a short backoff so a 60s hiccup doesn't turn into API downtime.
function connectMongo(attempt = 1) {
  mongoose.connect(process.env.MONGO_URI).catch((e) => {
    const wait = Math.min(30_000, 3_000 * attempt);
    console.error(`Mongo initial connect failed (attempt ${attempt}): ${e.message} — retrying in ${wait / 1000}s`);
    setTimeout(() => connectMongo(attempt + 1), wait);
  });
}
connectMongo();
require('./gridfs');
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');

  // One-time-per-boot cleanup: drop the legacy GridFS images bucket and any
  // S&S products with ObjectId-based image arrays from the abandoned sync.
  // Idempotent — running again is a no-op once everything is clean.
  setTimeout(() => {
    require('./controllers/product').runOneTimeCleanup()
      .catch((e) => console.warn('[cleanup] failure:', e.message));
  }, 2_000);

  // Nightly S&S price refresh (cron) + initial /styles/ cache warm so the
  // first visitor doesn't wait on the catalog endpoint.
  if (process.env.SS_ACCOUNT && process.env.SS_API_KEY) {
    require('./services/ssAutoSync').startSSAutoSync();
    setTimeout(() => require('./controllers/product').warmSSCache(), 5_000);
  }

  require('./services/jpwScheduler').startJpwScheduler();

  // Cold-outreach sender: paced, capped, business-hours-only email sequences
  // for CRM leads. Holds (never sends) until OUTREACH_EMAIL_FROM is set — cold
  // volume must never ride the main transactional identity.
  require('./services/outreachEngine').startOutreachEngine();

  // Read-only Gmail reply ingest: pulls inbound replies every 10 min and runs
  // them through triage (auto-stop / warm / suppress). Idle until GMAIL_* creds
  // are set; never modifies the mailbox.
  require('./controllers/replyTriage').startGmailIngest();

  // Auto-enroll: tops the chosen active campaign from the cold-lead reserve every
  // 30 min (idle until the owner turns it on for a campaign).
  require('./controllers/outreach').startAutoEnroll();

  // Always-on lead engine: every 6h it checks the cold-lead reserve and, when
  // low, sweeps successive states along the national rollout (milking each dry,
  // wrapping at the end). Free (OSM + own-site scrape); no toggle — the Studio
  // only reads its progress.
  require('./services/leadFinderScheduler').startLeadFinderScheduler();

  // Weekly push of the full backup (incl. R2 receipt images) to Google Drive.
  // No-op until the admin connects Drive — safe to start unconditionally.
  require('./services/gdriveBackup').startGoogleDriveBackup();

  // Repair any transaction whose denormalized `year` drifted from its `date`
  // (the cause of a phantom month appearing in the wrong year's trend).
  setTimeout(() => {
    require('./controllers/finances').resyncYears()
      .then((n) => { if (n) console.log(`[finances] re-synced year on ${n} transaction(s).`); })
      .catch((e) => console.warn('[finances] year resync failed:', e.message));
  }, 3_000);

  // Idempotent: fold retired CRM stages onto their live neighbor ('sampling' →
  // 'quoting') so the trimmed stage enum can never reject an old record's save.
  setTimeout(() => {
    require('./controllers/crm').migrateRetiredStages()
      .then((n) => { if (n) console.log(`[crm] migrated ${n} record(s) off retired stage 'sampling'.`); })
      .catch((e) => console.warn('[crm] retired-stage migration failed:', e.message));
  }, 4_500);

  // Idempotent: legacy approval links (minted before expiry existed) get a
  // 30-day fuse so no client-facing pricing page stays public forever.
  setTimeout(() => {
    require('./controllers/approval').expireLegacyApprovalTokens()
      .then((n) => { if (n) console.log(`[approval] set an expiry on ${n} legacy approval link(s).`); })
      .catch((e) => console.warn('[approval] legacy-token expiry backfill failed:', e.message));
  }, 5_500);

  // Idempotent: rename the income category "Customer Sales" → "Client Sales"
  // on stored transactions + receipt extractions (owner's vocabulary change).
  setTimeout(() => {
    require('./controllers/finances').migrateRenamedCategories()
      .then((n) => { if (n) console.log(`[finances] renamed the sales category on ${n} row(s).`); })
      .catch((e) => console.warn('[finances] category rename migration failed:', e.message));
  }, 4_000);

  // Idempotent: link legacy ledger rows to their project + vendor (fills blanks
  // only — including receipts the owner booked under a PROJECT # instead of the
  // invoice #, which otherwise read as "no receipts linked" on the order).
  setTimeout(() => {
    require('./controllers/finances').backfillTransactionLinks()
      .then((r) => { if (r.projFilled || r.vendorFilled) console.log(`[finances] linked ${r.projFilled} row(s) to projects, ${r.vendorFilled} to vendors.`); })
      .catch((e) => console.warn('[finances] transaction-link backfill failed:', e.message));
  }, 5_000);

  // Idempotent: give legacy studio-library docs a remoteId so the studio's
  // sync can dedupe them (empty ones re-imported as new rows on every load).
  setTimeout(() => {
    require('./controllers/studioLibrary').backfillRemoteIds()
      .catch((e) => console.warn('[studioLibrary] remoteId backfill failed:', e.message));
  }, 4_000);

  // Re-pick-up any receipts left mid-read (pending/processing) so a restart or a
  // cleared rate-limit window resumes scanning without losing anything. No-op
  // when ANTHROPIC_API_KEY isn't set (receipts just wait for manual entry).
  setTimeout(() => {
    require('./services/receiptScanner').resumeOnBoot()
      .catch((e) => console.warn('[receipts] resumeOnBoot failed:', e.message));
  }, 6_000);

  // Auto-migrate any remaining base64 images to R2 (idempotent, runs in the
  // background) once R2 is configured — so existing orders / mockups / logos
  // move over without a manual Shell step. Disable with R2_AUTOMIGRATE=off.
  if (require('./services/r2').isR2Configured() && process.env.R2_AUTOMIGRATE !== 'off') {
    setTimeout(() => {
      require('./scripts/migrateImagesToR2').migrateAll()
        .catch((e) => console.warn('[migrate] background run failed:', e.message));
    }, 8000);
  }
});

// ── Rate limiters ──
const contactLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});

const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', generalApiLimiter);

// The OWNER's Studio tooling (warm/refresh runs) is exempt from the per-IP public
// throttles. Must be the owner specifically — agents now hold validly-signed
// tokens too, so a bare signature check would wrongly exempt them from the metered
// S&S proxy cap. Bad/absent/agent token → treated as anonymous and rate-limited
// normally. Can't be spoofed (verify would throw).
function hasValidStudioToken(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !process.env.JWT_SECRET) return false;
  try {
    const decoded = jwt.verify(m[1], process.env.JWT_SECRET);
    return roleFrom(decoded) === 'owner';
  } catch (_) { return false; }
}

// Tighter throttle for the paid S&S catalog proxy (/api/products/ss/*). These
// endpoints hit our metered upstream, so anonymous scraping is a real cost.
// 50/min/IP is well above real browsing — a Products page load is 1–2 calls
// (one /ss/browse + an optional batched /ss/images), debounced — while capping
// abuse below the general 120/min. Authenticated Studio (the owner's warm/refresh
// runs) is exempted so admin tooling is never throttled.
const ssProxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  skip: hasValidStudioToken,
  message: { message: 'Too many catalog requests. Please slow down and try again shortly.' },
});

app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Routes ──
const productRoutes        = require('./routes/productRoutes');
const emailRoutes          = require('./routes/emailRoutes');
const authRoutes           = require('./routes/authRoutes');
const submissionRoutes     = require('./routes/submissionRoutes');
const scriptVersionRoutes  = require('./routes/scriptVersionRoutes');
const catalogRoutes        = require('./routes/catalogRoutes');
const siteSettingRoutes    = require('./routes/siteSettingRoutes');
const roadTripRoutes       = require('./routes/roadTripRoutes');
const studioRoutes         = require('./routes/studioRoutes');
const orderRoutes          = require('./routes/orderRoutes');
const clientLogoRoutes     = require('./routes/clientLogoRoutes');
const clientRoutes         = require('./routes/clientRoutes');
const publicApprovalRoutes = require('./routes/publicApprovalRoutes');
const backupRoutes         = require('./routes/backupRoutes');
const adminRoutes          = require('./routes/adminRoutes');
const agentRoutes          = require('./routes/agentRoutes');
const jpwRoutes            = require('./routes/jpwRoutes');
const gdriveRoutes         = require('./routes/gdriveRoutes');
const financeRoutes        = require('./routes/financeRoutes');
const receiptRoutes        = require('./routes/receiptRoutes');
const crmRoutes            = require('./routes/crmRoutes');
const dealRoutes           = require('./routes/dealRoutes');
const outreachRoutes       = require('./routes/outreachRoutes');
const triageRoutes         = require('./routes/triageRoutes');
const signalsRoutes        = require('./routes/signalsRoutes');

app.use('/api/products/ss', ssProxyLimiter);
app.use('/api/products', productRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/script-versions', scriptVersionRoutes);
app.use('/api/catalogs', catalogRoutes);
app.use('/api/site-settings', express.json({ limit: '2mb' }), siteSettingRoutes);
app.use('/api/roadtrip', roadTripRoutes);
app.use('/api/studio', studioRoutes);
app.use('/api/orders', express.json({ limit: '100mb' }), orderRoutes);
app.use('/api/client-logos', express.json({ limit: '2mb' }), clientLogoRoutes);
app.use('/api/clients', express.json(), clientRoutes);
// CRM import can carry the whole field tracker as JSON rows or raw CSV text, so
// allow a larger body than the global 1mb default.
app.use('/api/crm', express.json({ limit: '8mb' }), crmRoutes);
app.use('/api/deals', express.json(), dealRoutes);
app.use('/api/outreach', express.json(), outreachRoutes);
// Reply Triage: pasted/imported buyer replies — snippets only, small bodies.
app.use('/api/triage', express.json({ limit: '2mb' }), triageRoutes);
// Smart Alerts: read-only composed "what needs your attention" feed for the hub.
app.use('/api/signals', signalsRoutes);
app.use('/api/public', express.json(), publicApprovalRoutes);
app.use('/api/admin/backup', backupRoutes);
app.use('/api/admin', express.json({ limit: '2mb' }), adminRoutes); // owner-only agent management
app.use('/api/agent', express.json({ limit: '2mb' }), agentRoutes); // sales-agent portal (self-scoped)
app.use('/api/jpw', express.json({ limit: '20mb' }), jpwRoutes);
app.use('/api/gdrive', express.json(), gdriveRoutes);
app.use('/api/finances', express.json({ limit: '8mb' }), financeRoutes);
// 40mb: a single receipt can be a ~25 MB file, which is ~34 MB as base64 JSON.
// (The /batch zip route uses multipart via multer, so this limit doesn't gate it.)
app.use('/api/receipts', express.json({ limit: '40mb' }), receiptRoutes);
app.use('/api/email', contactLimiter, upload.array('files', 10), emailRoutes);

app.use((err, _req, res, next) => {
  if (err && err.message && err.message.includes('CORS')) {
    return res.status(400).json({ message: err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File too large (max 25 MB per file).' });
  }
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Server up & running on port ${PORT}`);
});
