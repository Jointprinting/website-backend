// controllers/product.js
require('dotenv').config();

const xml2js = require('xml2js');
const axios = require('axios');
const sharp = require('sharp');
const Product = require('../models/Product');
const { getGfs } = require('../gridfs');

// ─────────────────────────────────────────────────────────────────────────────
//  Pricing config — single source of truth, shared by AlphaBroder and S&S.
//
//  Logic: lowest blank piece-price × markup, then a spread for the high end
//  (which represents bigger sizes / lower run quantities), then round to the
//  nearest $0.50 with a $5 floor. Locked across all product imports.
// ─────────────────────────────────────────────────────────────────────────────
const PRICE_MARKUP = 2.5;
const PRICE_SPREAD = 1.4;
const round50c = (n) => Math.max(5, Math.round(n * 2) / 2);

// Deterministic pseudo-rating: 4.0–5.0 based on style string hash.
// Gives variety without being random on every sync.
function deriveRating(styleName = '') {
  let h = 0;
  for (let i = 0; i < styleName.length; i++) h = (h * 31 + styleName.charCodeAt(i)) | 0;
  const r = ((Math.abs(h) % 11) / 10) + 4; // 4.0 – 5.0
  return Math.round(r * 2) / 2; // round to nearest 0.5
}

// Auto-tag based on brand recognition and position
const PREMIUM_BRANDS = ['bella', 'canvas', 'next level', 'alternative', 'district', 'american apparel'];
const POPULAR_BRANDS = ['gildan', 'port', 'hanes', 'jerzees', 'sport-tek', 'carhartt'];
function deriveTag(brand = '', styleName = '') {
  const b = brand.toLowerCase();
  if (PREMIUM_BRANDS.some(p => b.includes(p))) return 'Our Favorite';
  if (POPULAR_BRANDS.some(p => b.includes(p))) return 'Best Seller';
  return 'New Arrival';
}

function deriveRange(basePrice) {
  // If we couldn't find a price, fall back to $8 base — yields $20–$28 final,
  // which roughly matches your most common shirt range.
  const safeBase = (typeof basePrice === 'number' && basePrice > 0) ? basePrice : 8;
  const lo = safeBase * PRICE_MARKUP;
  const hi = lo * PRICE_SPREAD;
  return { priceRangeBottom: round50c(lo), priceRangeTop: round50c(hi) };
}

// AlphaBroder XML can report price either at the item level or per-size. We
// look in both spots and keep the lowest piece-price we find. Field names vary
// across their feeds, so we try a handful of common ones before giving up.
function extractAlphaBroderMinPrice(item) {
  const PRICE_FIELDS = [
    'piecePrice', 'pieceprice', 'priceperpiece',
    'basepriceperpiece', 'basePricePerPiece', 'baseprice', 'basePrice',
    'piecedirectprice', 'price',
  ];
  const readPrice = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const f of PRICE_FIELDS) {
      const v = parseFloat(obj[f]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  };

  let min = readPrice(item);

  // Per-size pricing — each <size> element may have its own piecePrice.
  if (item?.sizes) {
    const sizesNode = Array.isArray(item.sizes) ? item.sizes[0] : item.sizes;
    let sizes = sizesNode?.size;
    if (sizes && !Array.isArray(sizes)) sizes = [sizes];
    if (Array.isArray(sizes)) {
      for (const s of sizes) {
        const p = readPrice(s);
        if (p !== null) min = (min === null) ? p : Math.min(min, p);
      }
    }
  }

  return min; // null if nothing found — caller falls back to default
}

// ─────────────────────────────────────────────────────────────────────────────
//  S&S Activewear constants
// ─────────────────────────────────────────────────────────────────────────────
const SS_API_BASE = process.env.SS_API_BASE || 'https://api.ssactivewear.com/V2';
const SS_CDN_BASE = process.env.SS_CDN_BASE || 'https://cdn.ssactivewear.com/';
const SS_ACCOUNT  = process.env.SS_ACCOUNT;
const SS_API_KEY  = process.env.SS_API_KEY;

// One axios instance reused across S&S calls
const ssClient = axios.create({
  baseURL: SS_API_BASE,
  auth: { username: SS_ACCOUNT || '', password: SS_API_KEY || '' },
  headers: { Accept: 'application/json' },
  timeout: 30_000,
});

function ensureSsCredentials() {
  if (!SS_ACCOUNT || !SS_API_KEY) {
    throw new Error(
      'S&S Activewear credentials are not configured. Set SS_ACCOUNT and SS_API_KEY env vars.'
    );
  }
}

function ssImageUrl(relPath) {
  if (!relPath) return null;
  if (relPath.startsWith('http')) return relPath;
  return SS_CDN_BASE + relPath.replace(/^\/+/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Granular category/type detection from product name.
//  Order matters — more-specific patterns must come before broader ones.
// ─────────────────────────────────────────────────────────────────────────────
function detectCategory(name = '') {
  const n = name.toLowerCase();
  // Zip-ups before hoodies — a "zip-up hoodie" should land in Zip-Ups
  if (/(full[-\s]?zip|zip[-\s]?up)/.test(n))                                      return 'Zip-Ups';
  if (/(hoodie|hooded)/.test(n))                                                   return 'Hoodies';
  // Crewneck sweatshirts / fleece (no hood implied)
  if (/(crewneck|crew[-\s]?neck|sweatshirt|fleece|sherpa)/.test(n))               return 'Crewnecks';
  if (/(tank|sleeveless|muscle)/.test(n))                                          return 'Tanks';
  if (/\bpolo\b/.test(n))                                                          return 'Polos';
  if (/(jacket|windbreaker|softshell|anorak|parka|vest|bomber|rain)/.test(n))     return 'Jackets';
  if (/(long[-\s]?sleeve|ls\b)/.test(n))                                          return 'Long Sleeve';
  // Shorts before pants so "gym shorts" doesn't match the pants pattern
  if (/\bshort[s]?\b/.test(n))                                                     return 'Shorts';
  if (/(pant|jogger|sweatpant|legging|trouser)/.test(n))                          return 'Pants';
  if (/(cap|hat|beanie|trucker|snapback|bucket|visor)/.test(n))                   return 'Hats';
  return 'T-Shirts'; // default — basic tee, jersey, etc.
}

function detectType(name = '') {
  const n = name.toLowerCase();
  if (/\b(ladies|women|womens|women's|woman's|female)\b/.test(n)) return 'Female';
  if (/\b(youth|kid|kids|toddler|infant|baby|junior)\b/.test(n))  return 'Kids';
  if (/\b(mens|men's|man's)\b/.test(n)) return 'Male';
  return 'Unisex';
}

// ─────────────────────────────────────────────────────────────────────────────
//  GridFS helpers (reused from the original controller)
// ─────────────────────────────────────────────────────────────────────────────
async function uploadImageToGridFS(imageUrl) {
  if (!imageUrl) return null;
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20_000 });
    const compressedBuffer = await sharp(response.data).resize({ width: 600 }).webp({ quality: 80 }).toBuffer();
    const gfs = getGfs();
    const uploadStream = gfs.openUploadStream(Date.now() + '-product-image.webp');
    uploadStream.end(compressedBuffer);
    return uploadStream.id;
  } catch (err) {
    console.error(`Error fetching image from URL: ${imageUrl}`, err.message);
    return null;
  }
}

async function getImageFromGridFS(imageId) {
  if (!imageId) return null;
  return new Promise((resolve, reject) => {
    const gfs = getGfs();
    const downloadStream = gfs.openDownloadStream(imageId);
    const chunks = [];
    downloadStream.on('data', (chunk) => chunks.push(chunk));
    downloadStream.on('end', () => {
      resolve(`data:image/webp;base64,${Buffer.concat(chunks).toString('base64')}`);
    });
    downloadStream.on('error', (err) => {
      console.error(`Error retrieving image with ID ${imageId}:`, err.message);
      resolve(null); // resolve null instead of rejecting so list endpoints don't fail
    });
  });
}

async function populateImages(product) {
  return {
    ...product.toObject(),
    productFrontImages: await Promise.all((product.productFrontImages || []).map(getImageFromGridFS)),
    productBackImages:  await Promise.all((product.productBackImages  || []).map(getImageFromGridFS)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public read endpoints (unchanged behavior)
// ─────────────────────────────────────────────────────────────────────────────
exports.getProducts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const skip = (page - 1) * limit;

    const { category, type, search, vendor } = req.query;
    const query = {};
    if (category) query.category = category;
    if (type)     query.type = type;
    if (vendor) {
      // Escape special regex chars so "Bella + Canvas" matches literally (case-insensitive)
      query.vendor = { $regex: vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }
    if (search) {
      const re = { $regex: `\\b${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };
      query.$or = [{ name: re }, { vendor: re }];
    }

    const products = await Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);
    if (!products.length) return res.status(200).json({ products: [], totalPages: 0 });

    const totalProducts = await Product.countDocuments(query);

    const productsWithImages = await Promise.all(
      products.map(async (product) => ({
        ...product.toObject(),
        productFrontImages: [await getImageFromGridFS(product.productFrontImages?.[0])],
        productBackImages:  [await getImageFromGridFS(product.productBackImages?.[0])],
      }))
    );

    res.status(200).json({ products: productsWithImages, totalPages: Math.ceil(totalProducts / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
};

exports.getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.status(200).json(await populateImages(product));
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};

exports.getProductByStyleCode = async (req, res) => {
  try {
    const product = await Product.findOne({ style: req.params.style });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.status(200).json(await populateImages(product));
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};

exports.getCategories = async (req, res) => {
  try {
    const categories = await Product.distinct('category');
    res.status(200).json({ categories });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch categories' });
  }
};

exports.getTypes = async (req, res) => {
  try {
    const types = await Product.distinct('type');
    res.status(200).json({ types });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch types' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  AlphaBroder XML add — manual entry path used by Studio
// ─────────────────────────────────────────────────────────────────────────────
exports.createProductFromAlphaBroder = async (req, res) => {
  try {
    if (!process.env.AB_USER || !process.env.AB_PASSWORD) {
      return res.status(503).json({
        message: 'Alpha Broder credentials are not configured.',
      });
    }

    const { data } = await axios.get(
      `https://dev.alphabroder.com/cgi-bin/online/xml/prod-detail-request.w?sr=${req.body.styleCode}&userName=${process.env.AB_USER}&password=${process.env.AB_PASSWORD}&rg=y`,
      {
        auth: {
          username: process.env.AB_BASIC_AUTH_USER,
          password: process.env.AB_BASIC_AUTH_PASSWORD,
        },
      }
    );

    const product = await parseAlphaBroderXML(data, req);
    if (typeof product === 'string') {
      return res.status(400).json({ message: product });
    }
    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: err.message });
  }
};

async function parseAlphaBroderXML(xmlString, req) {
  const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
  let productData;
  try { productData = await parser.parseStringPromise(xmlString); }
  catch (err) { return 'Could not parse Alpha Broder XML.'; }

  const item = productData.products?.item;
  if (!item) return 'No product data found in XML';

  let name = item.shortdescription || '';
  const vendor = item.brand || 'Joint Printing';
  const style = item.stylecode || '';
  let description = item.catalogdescription || '';
  description = description.split(' ').filter((w) => !w.includes('#') && !w.includes('&')).join(' ');
  name = name.replace(new RegExp(vendor, 'g'), '').replace(new RegExp(style, 'g'), '').replace(/\s+/g, ' ').trim();

  let sizeNames = [];
  if (item.sizes?.[0]?.size) {
    const sizes = Array.isArray(item.sizes[0].size) ? item.sizes[0].size : [item.sizes[0].size];
    sizeNames = sizes.map((s) => s.sizename);
  }

  const productFrontImages = [];
  const productBackImages = [];
  let colorArray = [];
  let colorCodes = [];

  if (item.colors?.color) {
    const colors = Array.isArray(item.colors.color) ? item.colors.color : [item.colors.color];
    for (const color of colors) {
      colorArray.push(capitalizeWords(color?.colorname));
      if (color.hexcode) {
        let hex = color.hexcode;
        if (!hex.startsWith('#')) hex = '#' + hex;
        colorCodes.push(hex.toUpperCase());
      } else {
        colorCodes.push('#CCCCCC');
      }

      productFrontImages.push(color['image-front'] ? await uploadImageToGridFS(color['image-front'].replace('dev-wam.', '')) : null);
      productBackImages.push(color['image-back']  ? await uploadImageToGridFS(color['image-back'].replace('dev-wam.', ''))  : null);
    }
  }

  // ── Auto pricing: pull blank cost from the XML, mark it up, derive a range.
  // If the request body still passes priceRangeBottom/Top (legacy callers),
  // honor them; otherwise compute from XML. Same for rating/tag — defaults
  // applied when not provided.
  const xmlMinPrice = extractAlphaBroderMinPrice(item);
  const derived = deriveRange(xmlMinPrice);

  const priceRangeBottom = req.body.priceRangeBottom != null && req.body.priceRangeBottom !== ''
    ? Number(req.body.priceRangeBottom)
    : derived.priceRangeBottom;
  const priceRangeTop = req.body.priceRangeTop != null && req.body.priceRangeTop !== ''
    ? Number(req.body.priceRangeTop)
    : derived.priceRangeTop;

  const product = new Product({
    name, vendor, style, description,
    sizeRangeBottom: sizeNames[0] || 'S',
    sizeRangeTop:    sizeNames[sizeNames.length - 1] || 'XL',
    colors: colorArray,
    colorCodes,
    productFrontImages,
    productBackImages,
    category: req.body.category,
    priceRangeBottom,
    priceRangeTop,
    basePrice: xmlMinPrice || undefined,
    rating: req.body.rating || 5,
    tag: req.body.tag || 'New Arrival',
    type: req.body.type,
    source: 'alphabroder',
  });

  await product.save();
  return product;
}

// ─────────────────────────────────────────────────────────────────────────────
//  S&S Activewear sync — the new flow
// ─────────────────────────────────────────────────────────────────────────────
//
// We hit GET /Products.aspx?style=<styleName>&mediatype=json which returns
// one record per SKU (style × color × size). We collapse those into a single
// Product per style: deduped colors, size range, lowest piece-price for the
// markup math, and one front/back image per color.
//
async function fetchSSProducts(styleName) {
  ensureSsCredentials();

  // S&S supports filtering by style via the ?style= query parameter.
  // Returns an array of SKU records.
  const { data } = await ssClient.get('/Products.aspx', {
    params: { style: styleName, mediatype: 'json' },
  });

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No SKUs found for style "${styleName}".`);
  }
  return data;
}

function summarizeSsStyle(skus) {
  // All SKUs share the same styleName + brandName.
  const first = skus[0];
  const styleName = first.styleName;
  const brand = first.brandName;

  // Grab style-level title — S&S puts it in styleName / styleTitle / styleDescription
  // depending on endpoint. We'll synthesize from what we have.
  // Many SKUs have a top-level "title" field; if present, prefer it.
  const titleCandidate =
    first.title ||
    first.styleTitle ||
    first.styleDescription ||
    `${brand} ${styleName}`;

  // Collapse colors: dedupe by colorName
  const colorMap = new Map();
  const sizeSet = new Set();
  let minPrice = Infinity;

  for (const sku of skus) {
    if (sku.sizeName) sizeSet.add(sku.sizeName);
    if (typeof sku.piecePrice === 'number' && sku.piecePrice > 0) {
      minPrice = Math.min(minPrice, sku.piecePrice);
    }
    if (sku.colorName && !colorMap.has(sku.colorName)) {
      colorMap.set(sku.colorName, {
        name: sku.colorName,
        hex: sku.color1 || '#CCCCCC',
        front: ssImageUrl(sku.colorFrontImage),
        back: ssImageUrl(sku.colorBackImage),
      });
    }
  }

  // Order sizes sensibly
  const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL', '6XL'];
  const orderedSizes = [...sizeSet].sort((a, b) => {
    const ai = sizeOrder.indexOf(a.toUpperCase());
    const bi = sizeOrder.indexOf(b.toUpperCase());
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return {
    styleName,
    brand,
    title: titleCandidate,
    minPrice: minPrice === Infinity ? null : minPrice,
    sizeRangeBottom: orderedSizes[0] || 'S',
    sizeRangeTop:    orderedSizes[orderedSizes.length - 1] || 'XL',
    colors: [...colorMap.values()],
    ssStyleID: first.styleID,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Light nightly refresh — updates prices & sizes for all S&S-sourced products
//  without re-downloading images (too expensive for an automated nightly job).
// ─────────────────────────────────────────────────────────────────────────────
async function refreshAllSSProducts() {
  ensureSsCredentials();
  const ssProducts = await Product.find({ source: 'ssactivewear' }).select('style').lean();

  let updated = 0;
  const failed = [];

  for (const p of ssProducts) {
    try {
      const skus = await fetchSSProducts(p.style);
      const summary = summarizeSsStyle(skus);
      const { priceRangeBottom, priceRangeTop } = deriveRange(summary.minPrice);

      await Product.updateOne(
        { style: p.style },
        {
          $set: {
            basePrice: summary.minPrice,
            priceRangeBottom,
            priceRangeTop,
            sizeRangeBottom: summary.sizeRangeBottom,
            sizeRangeTop: summary.sizeRangeTop,
            rating: deriveRating(p.style),
            updatedAt: new Date(),
          },
        }
      );
      updated++;
    } catch (e) {
      console.error(`[SS refresh] "${p.style}":`, e.message);
      failed.push({ style: p.style, reason: e.message });
    }
    // Small pause to avoid hammering the S&S API
    await new Promise((r) => setTimeout(r, 300));
  }

  return { updated, total: ssProducts.length, failed };
}

// Exposed for the cron service (not an HTTP handler itself)
exports._refreshAllSSProducts = refreshAllSSProducts;

/**
 * POST /api/products/ss/refresh-all
 * Manually trigger a price+size refresh for all S&S-sourced products.
 * Auth: requireAdmin
 */
exports.refreshAllSSProductsHandler = async (req, res) => {
  try {
    const results = await refreshAllSSProducts();
    return res.status(200).json(results);
  } catch (err) {
    console.error('refreshAllSS error:', err);
    return res.status(500).json({ message: err.message || 'Refresh failed.' });
  }
};

/**
 * POST /api/products/ss/sync
 * Body: { styles: [string], tag?, markup?, overrideCategory?, overrideType? }
 * Auth: requireAdmin
 */
exports.syncFromSS = async (req, res) => {
  try {
    ensureSsCredentials();

    const { styles, tag, markup, overrideCategory, overrideType } = req.body || {};
    if (!Array.isArray(styles) || styles.length === 0) {
      return res.status(400).json({ message: 'Provide a non-empty `styles` array.' });
    }
    if (styles.length > 50) {
      return res.status(400).json({ message: 'Sync at most 50 styles per request.' });
    }

    const markupNum = Number.isFinite(Number(markup)) && Number(markup) > 0 ? Number(markup) : PRICE_MARKUP;
    const tagToUse = typeof tag === 'string' && tag ? tag : 'New Arrival';

    let created = 0;
    let updated = 0;
    const products = [];
    const failed = [];

    for (const styleName of styles) {
      try {
        const skus = await fetchSSProducts(styleName);
        const summary = summarizeSsStyle(skus);

        const category = overrideCategory || detectCategory(summary.title);
        const type     = overrideType     || detectType(summary.title);

        // Pricing — same shape as deriveRange() but with the caller's markup
        // override (default already === PRICE_MARKUP) and the locked spread.
        const baseLo = (summary.minPrice || 8) * markupNum;
        const baseHi = baseLo * PRICE_SPREAD;
        const priceRangeBottom = round50c(baseLo);
        const priceRangeTop    = round50c(baseHi);

        // Upload one front/back image per color (in order)
        const productFrontImages = [];
        const productBackImages = [];
        const colors = [];
        const colorCodes = [];

        for (const c of summary.colors) {
          colors.push(c.name);
          colorCodes.push((c.hex || '#CCCCCC').toUpperCase());
          productFrontImages.push(c.front ? await uploadImageToGridFS(c.front) : null);
          productBackImages.push(c.back ? await uploadImageToGridFS(c.back) : null);
        }

        const update = {
          name: summary.title,
          vendor: summary.brand || 'S&S Activewear',
          brandName: summary.brand,
          style: summary.styleName,
          ssStyleID: summary.ssStyleID,
          source: 'ssactivewear',
          basePrice: summary.minPrice,
          description: `${summary.brand} ${summary.styleName} — ${summary.title}`,
          sizeRangeBottom: summary.sizeRangeBottom,
          sizeRangeTop: summary.sizeRangeTop,
          colors,
          colorCodes,
          productFrontImages,
          productBackImages,
          rating: deriveRating(summary.styleName),
          tag: tagToUse,
          category,
          type,
          priceRangeBottom,
          priceRangeTop,
        };

        const existing = await Product.findOne({ style: summary.styleName });
        let saved;
        if (existing) {
          // Don't overwrite manual price overrides if they already differ from default behavior.
          // Strategy: leave priceRangeBottom/Top untouched on update, refresh the rest.
          delete update.priceRangeBottom;
          delete update.priceRangeTop;
          Object.assign(existing, update);
          saved = await existing.save();
          updated++;
        } else {
          saved = await Product.create(update);
          created++;
        }

        products.push({
          style: saved.style,
          name: saved.name,
          vendor: saved.vendor,
          category: saved.category,
          type: saved.type,
        });
      } catch (e) {
        console.error(`[SS sync] failed for "${styleName}":`, e.message);
        failed.push({ style: styleName, reason: e.message || 'Unknown error' });
      }
    }

    return res.status(200).json({ created, updated, products, failed });
  } catch (err) {
    console.error('syncFromSS error:', err);
    return res.status(500).json({ message: err.message || 'S&S sync failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Utility
// ─────────────────────────────────────────────────────────────────────────────
function capitalizeWords(s = '') {
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Backward-compat alias for the existing /add endpoint.
exports.createProduct = exports.createProductFromAlphaBroder;

// ─────────────────────────────────────────────────────────────────────────────
//  importFromJson — bulk-import products from a JSON array (ChatGPT/PDF flow)
//
//  POST /api/products/import-json
//  Body: { products: [...], defaultTag?, defaultCategory? }
//  Auth: requireAdmin
//
//  The studio's "PDF Catalog Import" tab calls this. We accept a flexible JSON
//  shape (since ChatGPT might miss fields) and fill in sensible defaults.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_CATEGORIES = ['T-Shirts', 'Long Sleeve', 'Hoodies', 'Crewnecks', 'Zip-Ups', 'Tanks', 'Polos', 'Jackets', 'Pants', 'Shorts', 'Hats', 'Promo'];
const ALLOWED_TYPES = ['Unisex', 'Male', 'Female', 'Kids'];
const ALLOWED_TAGS = ['Best Seller', 'New Arrival', 'Clearance', 'Our Favorite', 'Exclusive'];

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeString(v, fallback = '') {
  if (typeof v !== 'string') return fallback;
  return v.trim() || fallback;
}

function pickFromList(v, list, fallback) {
  if (typeof v !== 'string') return fallback;
  const match = list.find((x) => x.toLowerCase() === v.trim().toLowerCase());
  return match || fallback;
}

function safeArray(v) {
  return Array.isArray(v) ? v.filter(Boolean) : [];
}

exports.importFromJson = async (req, res) => {
  try {
    const { products: rawProducts, defaultTag, defaultCategory } = req.body || {};
    if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
      return res.status(400).json({ message: 'Provide a non-empty `products` array.' });
    }
    if (rawProducts.length > 200) {
      return res.status(400).json({ message: 'Import at most 200 products per request.' });
    }

    const fallbackTag = pickFromList(defaultTag, ALLOWED_TAGS, 'New Arrival');
    const fallbackCategory = pickFromList(defaultCategory, ALLOWED_CATEGORIES, 'Promo');

    let created = 0;
    let updated = 0;
    const products = [];
    const failed = [];

    for (let i = 0; i < rawProducts.length; i++) {
      const raw = rawProducts[i] || {};
      try {
        const style = safeString(raw.style || raw.styleCode || raw.sku);
        if (!style) {
          failed.push({ style: `item #${i + 1}`, reason: 'Missing required field "style"' });
          continue;
        }

        const name = safeString(raw.name || raw.title, `Product ${style}`);
        const vendor = safeString(raw.vendor || raw.brand || raw.brandName, 'Joint Printing');
        const description = safeString(raw.description, `${vendor} ${name}`);
        const category = pickFromList(raw.category, ALLOWED_CATEGORIES, fallbackCategory);
        const type = pickFromList(raw.type || raw.fit, ALLOWED_TYPES, 'Unisex');
        const tag = pickFromList(raw.tag, ALLOWED_TAGS, fallbackTag);
        const rating = Math.max(1, Math.min(5, Math.round(safeNumber(raw.rating, 5))));

        const priceRangeBottom = safeNumber(raw.priceRangeBottom || raw.priceMin || raw.minPrice, 5);
        const priceRangeTop = safeNumber(raw.priceRangeTop || raw.priceMax || raw.maxPrice, Math.max(priceRangeBottom + 5, 15));

        const sizeRangeBottom = safeString(raw.sizeRangeBottom || raw.sizeMin, 'OS');
        const sizeRangeTop = safeString(raw.sizeRangeTop || raw.sizeMax, sizeRangeBottom);

        const colors = safeArray(raw.colors).map((c) => String(c)).filter(Boolean);
        const colorCodes = safeArray(raw.colorCodes).map((c) => {
          let s = String(c).trim();
          if (s && !s.startsWith('#')) s = '#' + s;
          return s.toUpperCase();
        });

        // Pad colorCodes to match colors length (default to gray)
        while (colorCodes.length < colors.length) colorCodes.push('#CCCCCC');
        if (colors.length === 0) {
          colors.push('Black');
          colorCodes.push('#000000');
        }

        // Optional image URLs from the JSON. We attempt to upload each one,
        // but DON'T fail the whole product if images can't be fetched (they
        // can be added manually later).
        const imageUrls = safeArray(raw.imageUrls || raw.images);
        const productFrontImages = [];
        for (const url of imageUrls.slice(0, colors.length || 1)) {
          try {
            const id = await uploadImageToGridFS(url);
            productFrontImages.push(id);
          } catch (_) {
            productFrontImages.push(null);
          }
        }
        // Pad with nulls so the array length matches colors length
        while (productFrontImages.length < colors.length) productFrontImages.push(null);
        const productBackImages = colors.map(() => null);

        const update = {
          name,
          vendor,
          style,
          description,
          source: 'manual',
          sizeRangeBottom,
          sizeRangeTop,
          colors,
          colorCodes,
          productFrontImages,
          productBackImages,
          rating,
          tag,
          category,
          type,
          priceRangeBottom,
          priceRangeTop,
        };

        const existing = await Product.findOne({ style });
        let saved;
        if (existing) {
          Object.assign(existing, update);
          saved = await existing.save();
          updated++;
        } else {
          saved = await Product.create(update);
          created++;
        }

        products.push({
          style: saved.style,
          name: saved.name,
          vendor: saved.vendor,
          category: saved.category,
          type: saved.type,
        });
      } catch (e) {
        console.error(`[JSON import] failed for item ${i}:`, e.message);
        failed.push({ style: raw?.style || `item #${i + 1}`, reason: e.message || 'Unknown error' });
      }
    }

    return res.status(200).json({ created, updated, products, failed });
  } catch (err) {
    console.error('importFromJson error:', err);
    return res.status(500).json({ message: err.message || 'JSON import failed.' });
  }
};

// ─── S&S Live Browse ───────────────────────────────────────────────────────────
// Simple in-memory cache: key → { data, expiresAt }
const _ssCache = new Map();
const SS_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

async function fetchAndGroupSSBrand(brand) {
  const cacheKey = `brand:${brand}`;
  const cached = _ssCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  // Build URL manually so brand name is encoded exactly once by encodeURIComponent
  const { data } = await ssClient.get(
    `/Products.aspx?brand=${encodeURIComponent(brand)}&mediatype=json`,
    { timeout: 90_000 }
  );

  if (!Array.isArray(data)) {
    // S&S returned an error object — surface its message if present
    const detail = data?.Message || data?.message || JSON.stringify(data).slice(0, 200);
    console.error(`[browseSS] S&S returned non-array for brand "${brand}":`, detail);
    throw new Error(`S&S catalog unavailable for this brand. (${detail})`);
  }

  // Group SKUs → styles
  const byStyle = new Map();
  for (const sku of data) {
    if (!sku.styleName) continue;
    if (!byStyle.has(sku.styleName)) byStyle.set(sku.styleName, []);
    byStyle.get(sku.styleName).push(sku);
  }

  const styles = [];
  for (const skus of byStyle.values()) {
    const s = summarizeSsStyle(skus);
    const { priceRangeBottom, priceRangeTop } = deriveRange(s.minPrice);
    styles.push({
      style: s.styleName,
      name: s.title,
      vendor: s.brand,
      category: detectCategory(s.title),
      type: detectType(s.title),
      priceRangeBottom,
      priceRangeTop,
      sizeRangeBottom: s.sizeRangeBottom,
      sizeRangeTop: s.sizeRangeTop,
      colorCount: s.colors.length,
      rating: deriveRating(s.styleName),
      tag: deriveTag(s.brand, s.styleName),
      image: s.colors[0]?.front ? ssImageUrl(s.colors[0].front) : null,
    });
  }

  styles.sort((a, b) => a.style.localeCompare(b.style));
  const result = { styles, total: styles.length };
  _ssCache.set(cacheKey, { data: result, expiresAt: Date.now() + SS_CACHE_TTL });
  return result;
}

// Fetches all popular brands in parallel and merges into a single deduplicated
// catalog. Results are cached under the 'all-brands' key for 4 hours — the
// same TTL as individual brand caches so they expire together.
async function fetchAllSSBrands() {
  const cacheKey = 'all-brands';
  const cached = _ssCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const results = await Promise.allSettled(
    SS_POPULAR_BRANDS.map((brand) => fetchAndGroupSSBrand(brand))
  );

  const seenStyles = new Set();
  const allStyles = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const s of r.value.styles) {
        if (!seenStyles.has(s.style)) {
          seenStyles.add(s.style);
          allStyles.push(s);
        }
      }
    }
  }

  // Sort alphabetically by product name for a consistent browsing experience
  allStyles.sort((a, b) => a.name.localeCompare(b.name));
  const data = { styles: allStyles, total: allStyles.length };
  _ssCache.set(cacheKey, { data, expiresAt: Date.now() + SS_CACHE_TTL });
  return data;
}

/**
 * GET /api/products/ss/browse
 * Query: brand? (omit for all popular brands), category?, type?, search?, page?, limit?
 */
exports.browseSS = async (req, res) => {
  try {
    ensureSsCredentials();
    const { brand, page = 1, limit = 24, search = '', category = '', type = '' } = req.query;

    // When no brand is specified, serve the merged catalog across all popular brands.
    const result = brand
      ? await fetchAndGroupSSBrand(brand)
      : await fetchAllSSBrands();

    let { styles } = result;

    if (category) styles = styles.filter((s) => s.category === category);
    if (type)     styles = styles.filter((s) => s.type === type);
    if (search) {
      const q = search.toLowerCase();
      styles = styles.filter((s) =>
        s.name.toLowerCase().includes(q) || s.style.toLowerCase().includes(q)
      );
    }

    const total = styles.length;
    const p = Math.max(1, parseInt(page, 10));
    const l = Math.min(48, Math.max(1, parseInt(limit, 10)));
    const start = (p - 1) * l;

    return res.json({
      products: styles.slice(start, start + l),
      total,
      page: p,
      totalPages: Math.ceil(total / l),
    });
  } catch (err) {
    console.error('browseSS error:', err.message);
    return res.status(500).json({ message: err.message || 'Browse failed.' });
  }
};

// Hardcoded list of popular S&S brands (avoids a live brands API call on every page load)
const SS_POPULAR_BRANDS = [
  'Bella + Canvas', 'Gildan', 'Port & Company', 'Port Authority',
  'Sport-Tek', 'Next Level', 'Alternative Apparel', 'Hanes',
  'District', 'Carhartt', 'Jerzees', 'Champion',
  'Independent Trading Co.', 'Comfort Colors', 'LAT Apparel',
];

exports.getSSBrands = (_req, res) => {
  res.json({ brands: SS_POPULAR_BRANDS });
};

/**
 * GET /api/products/ss/style/:style
 * Returns full detail for a single S&S style (all colors + images) from the
 * live S&S API.  Used by the Product detail page when the style isn't in the DB.
 */
exports.getSSStyleDetail = async (req, res) => {
  try {
    ensureSsCredentials();
    const skus = await fetchSSProducts(req.params.style);
    const summary = summarizeSsStyle(skus);
    const { priceRangeBottom, priceRangeTop } = deriveRange(summary.minPrice);

    return res.json({
      style: summary.styleName,
      name: summary.title,
      vendor: summary.brand,
      category: detectCategory(summary.title),
      type: detectType(summary.title),
      priceRangeBottom,
      priceRangeTop,
      sizeRangeBottom: summary.sizeRangeBottom,
      sizeRangeTop: summary.sizeRangeTop,
      colors: summary.colors.map((c) => c.name),
      colorCodes: summary.colors.map((c) => (c.hex || '#CCCCCC').toUpperCase()),
      productFrontImages: summary.colors.map((c) => c.front || null),
      productBackImages: summary.colors.map((c) => c.back || null),
      rating: deriveRating(summary.styleName),
      tag: deriveTag(summary.brand, summary.title),
      description: `${summary.brand} ${summary.styleName} — ${summary.title}`,
    });
  } catch (err) {
    console.error('getSSStyleDetail error:', err.message);
    return res.status(500).json({ message: err.message || 'Could not fetch style detail.' });
  }
};
