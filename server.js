// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const fs = require('fs');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

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

app.use(express.json({ limit: '1mb' }));
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

// ── Mongo ──
mongoose.connect(process.env.MONGO_URI);
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
const jpwRoutes            = require('./routes/jpwRoutes');
const gdriveRoutes         = require('./routes/gdriveRoutes');
const financeRoutes        = require('./routes/financeRoutes');
const receiptRoutes        = require('./routes/receiptRoutes');

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
app.use('/api/public', express.json(), publicApprovalRoutes);
app.use('/api/admin/backup', backupRoutes);
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
