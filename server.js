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

// ── Trust the platform's reverse proxy so req.ip is the real client IP
//    (Render, Vercel functions, etc. set X-Forwarded-For). ──
app.set('trust proxy', 1);

// ── Security headers (with permissive CORS so the SPA can still talk to us) ──
app.use(helmet({
  // The frontend is on a different origin so don't enable strict CORP defaults.
  crossOriginResourcePolicy: false,
  // We're an API, so disable HSTS via helmet (let the platform handle TLS).
  contentSecurityPolicy: false,
}));

// CORS — restrict to known origins via env, fall back to permissive.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin (curl, server-to-server, mobile webviews)
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));

app.use(express.json({ limit: '1mb' }));

// Studio library routes need larger JSON body (base64 images can be several MB)
app.use('/api/studio', express.json({ limit: '20mb' }));

// Ensure the uploads directory exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Multer storage with size + count caps
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename:    (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB per file
    files: 10,
  },
  // No fileFilter — accept any file type; uploads go directly to the business owner
});

// ── Mongo ──
mongoose.connect(process.env.MONGO_URI);
require('./gridfs');
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
  // Start the nightly S&S price refresh only if credentials are present
  if (process.env.SS_ACCOUNT && process.env.SS_API_KEY) {
    require('./services/ssAutoSync').startSSAutoSync();
  }
  // Start the JPW recon nightly jobs (re-score + stale-audit refresh)
  require('./services/jpwScheduler').startJpwScheduler();
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

// Health check
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
const quoterRoutes         = require('./routes/quoterRoutes');
const jpwRoutes            = require('./routes/jpwRoutes');

app.use('/api/products', productRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/script-versions', scriptVersionRoutes);
app.use('/api/catalogs', catalogRoutes);
app.use('/api/site-settings', siteSettingRoutes);
app.use('/api/roadtrip', roadTripRoutes);
app.use('/api/studio', studioRoutes);
app.use('/api/quoter', quoterRoutes);
// JPW lead recon endpoint accepts CSV imports of up to 5k rows; bump the JSON
// body limit so Apify/OutScraper exports don't get rejected at the parser.
app.use('/api/jpw', express.json({ limit: '20mb' }), jpwRoutes);

// IMPORTANT: field name "files" must match FormData.append('files', ...)
app.use('/api/email', contactLimiter, upload.array('files', 10), emailRoutes);

// Multer error handler
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
