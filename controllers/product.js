// controllers/product.js
require('dotenv').config();

const xml2js = require('xml2js');
const axios = require('axios');
const sharp = require('sharp');
const Product = require('../models/Product');
const { getGfs } = require('../gridfs');

// ─────────────────────────────────────────────────────────────────────────────
//  Pricing config
// ─────────────────────────────────────────────────────────────────────────────
const PRICE_MARKUP = 2.0;
const PRICE_SPREAD = 1.2;
const roundDollar = (n) => Math.max(5, Math.round(n));

function deriveRating(styleName = '') {
  let h = 0;
  for (let i = 0; i < styleName.length; i++) h = (h * 31 + styleName.charCodeAt(i)) | 0;
  const r = ((Math.abs(h) % 11) / 10) + 4;
  return Math.round(r * 2) / 2;
}

const PREMIUM_BRANDS = ['bella', 'canvas', 'next level', 'alternative', 'district', 'american apparel'];
const POPULAR_BRANDS_TAG = ['gildan', 'port', 'hanes', 'jerzees', 'sport-tek', 'carhartt'];
function deriveTag(brand = '', styleName = '') {
  const b = brand.toLowerCase();
  if (PREMIUM_BRANDS.some(p => b.includes(p))) return 'Our Favorite';
  if (POPULAR_BRANDS_TAG.some(p => b.includes(p))) return 'Best Seller';
  return 'New Arrival';
}

function deriveRange(basePrice) {
  if (typeof basePrice !== 'number' || !(basePrice > 0)) {
    return { priceRangeBottom: null, priceRangeTop: null };
  }
  const lo = basePrice * PRICE_MARKUP;
  const hi = lo * PRICE_SPREAD;
  return { priceRangeBottom: roundDollar(lo), priceRangeTop: roundDollar(hi) };
}

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

  return min;
}

// ─────────────────────────────────────────────────────────────────────────────
//  S&S Activewear constants
// ─────────────────────────────────────────────────────────────────────────────
const SS_API_BASE = process.env.SS_API_BASE || 'https://api.ssactivewear.com/V2';
const SS_CDN_BASE = process.env.SS_CDN_BASE || 'https://cdn.ssactivewear.com/';
const SS_ACCOUNT  = process.env.SS_ACCOUNT;
const SS_API_KEY  = process.env.SS_API_KEY;

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

function pickSSImagePath(row) {
  if (!row) return null;
  return row.image
    || row.colorFrontImage
    || row.styleImage
    || row.styleImageFront
    || row.frontImage
    || null;
}

const SS_SIZE_ORDER = [
  'NB', '0-3M', '3-6M', '6-12M', '6M', '12M', '12-18M', '18M', '18-24M', '24M',
  '2T', '3T', '4T', '5T', '5/6', '6T', '6/7', '7', '8', '10', '12', '14', '16', '18',
  'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL', '8XL',
  'OS', 'OSFA', 'OSFM', 'One Size',
];

function sortSizes(sizes) {
  return [...sizes].sort((a, b) => {
    const ai = SS_SIZE_ORDER.indexOf(a);
    const bi = SS_SIZE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Granular category/type detection.
// ─────────────────────────────────────────────────────────────────────────────
function detectCategory(name = '') {
  const n = name.toLowerCase();
  if (/(full[-\s]?zip|zip[-\s]?up)/.test(n))                                      return 'Zip-Ups';
  if (/(hoodie|hooded)/.test(n))                                                   return 'Hoodies';
  if (/(crewneck|crew[-\s]?neck|sweatshirt|fleece|sherpa)/.test(n))               return 'Crewnecks';
  if (/(tank|sleeveless|muscle)/.test(n))                                          return 'Tanks';
  if (/\bpolo\b/.test(n))                                                          return 'Polos';
  if (/(jacket|windbreaker|softshell|anorak|parka|vest|bomber|rain)/.test(n))     return 'Jackets';
  if (/(long[-\s]?sleeve|ls\b)/.test(n))                                          return 'Long Sleeve';
  if (/\bshort[s]?\b/.test(n))                                                     return 'Shorts';
  if (/(pant|jogger|sweatpant|legging|trouser)/.test(n))                          return 'Pants';
  if (/(cap|hat|beanie|trucker|snapback|bucket|visor)/.test(n))                   return 'Hats';
  return 'T-Shirts';
}

function detectType(name = '') {
  const n = name.toLowerCase();
  if (/\b(ladies|women|womens|women's|woman's|female)\b/.test(n)) return 'Female';
  if (/\b(youth|kid|kids|toddler|infant|baby|junior)\b/.test(n))  return 'Kids';
  if (/\b(mens|men's|man's)\b/.test(n)) return 'Male';
  return 'Unisex';
}

// ─────────────────────────────────────────────────────────────────────────────
//  GridFS helpers
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
      resolve(null);
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
//  Public read endpoints
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
//  AlphaBroder XML add
// ─────────────────────────────────────────────────────────────────────────────
exports.createProductFromAlphaBroder = async (req, res) => {
  try {
    if (!process.env.AB_USER || !process.env.AB_PASSWORD) {
      return res.status(503).json({ message: 'Alpha Broder credentials are not configured.' });
    }
    const { data } = await axios.get(
      `https://dev.alphabroder.com/cgi-bin/online/xml/prod-detail-request.w?sr=${req.body.styleCode}&userName=${process.env.AB_USER}&password=${process.env.AB_PASSWORD}&rg=y`,
      { auth: { username: process.env.AB_BASIC_AUTH_USER, password: process.env.AB_BASIC_AUTH_PASSWORD } }
    );
    const product = await parseAlphaBroderXML(data, req);
    if (typeof product === 'string') return res.status(400).json({ message: product });
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

  const xmlMinPrice = extractAlphaBroderMinPrice(item);
  const derived = deriveRange(xmlMinPrice);
  const priceRangeBottom = req.body.priceRangeBottom != null && req.body.priceRangeBottom !== '' ? Number(req.body.priceRangeBottom) : derived.priceRangeBottom;
  const priceRangeTop    = req.body.priceRangeTop    != null && req.body.priceRangeTop    !== '' ? Number(req.body.priceRangeTop)    : derived.priceRangeTop;

  const product = new Product({
    name, vendor, style, description,
    sizeRangeBottom: sizeNames[0] || 'S',
    sizeRangeTop:    sizeNames[sizeNames.length - 1] || 'XL',
    colors: colorArray, colorCodes,
    productFrontImages, productBackImages,
    category: req.body.category,
    priceRangeBottom, priceRangeTop,
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
//  S&S Activewear — per-style SKU fetch
// ─────────────────────────────────────────────────────────────────────────────
// S&S V2 supports two ways to fetch SKUs for one style:
//   1. GET /v2/products/{identifier}  — URL path, accepts styleName / partNumber
//      / styleID / SKU. This is the documented, scoped-to-one-style version.
//   2. GET /v2/products/?style=X      — query filter. Behaviour varies; we've
//      seen it return SKUs from unrelated styles mixed in.
//
// We try (1) first. If it fails or returns nothing, we fall back to (2) with
// a relaxed filter that matches styleName OR partNumber (S&S sometimes stores
// the user-facing code in partNumber and the SS-internal name in styleName,
// e.g. partNumber="12500", styleName="G185000" for the same Gildan style).
//
// Diagnostic logging on the first call so we can see what S&S actually
// returns when matches fail — easier to debug from Render logs than guessing.
async function fetchSSProducts(styleName) {
  ensureSsCredentials();
  const target = String(styleName || '').trim();
  if (!target) throw new Error('styleName required');
  const targetLower = target.toLowerCase();

  const matchesTarget = (sku) => {
    const sn = (sku?.styleName || '').trim().toLowerCase();
    const pn = (sku?.partNumber || '').trim().toLowerCase();
    return sn === targetLower || pn === targetLower;
  };

  // Strategy 1: URL path (canonical, scoped).
  try {
    const { data } = await ssClient.get(`/products/${encodeURIComponent(target)}`);
    if (Array.isArray(data) && data.length > 0) {
      // URL path is supposed to be tightly scoped — if it returned anything,
      // it's almost certainly for the requested style. But still apply a
      // sanity filter; if zero rows match the requested style, fall through.
      const matched = data.filter(matchesTarget);
      if (matched.length > 0) return matched;
      if (!fetchSSProducts._urlPathLogged) {
        fetchSSProducts._urlPathLogged = true;
        console.log(`[fetchSSProducts] /products/${target} returned ${data.length} rows but none matched styleName/partNumber.`,
          `Sample row keys: ${Object.keys(data[0]).slice(0, 12).join(', ')}.`,
          `Sample styleName="${data[0]?.styleName}", partNumber="${data[0]?.partNumber}".`);
      }
    }
  } catch (e) {
    console.warn(`[fetchSSProducts] path /products/${target} failed:`, e.message);
  }

  // Strategy 2: query param (legacy, looser).
  try {
    const { data } = await ssClient.get('/products/', { params: { style: target } });
    if (Array.isArray(data) && data.length > 0) {
      const matched = data.filter(matchesTarget);
      if (matched.length > 0) return matched;
      if (!fetchSSProducts._queryLogged) {
        fetchSSProducts._queryLogged = true;
        console.log(`[fetchSSProducts] /products/?style=${target} returned ${data.length} rows but none matched styleName/partNumber.`,
          `Sample styleName="${data[0]?.styleName}", partNumber="${data[0]?.partNumber}".`);
      }
    }
  } catch (e) {
    console.warn(`[fetchSSProducts] /products/?style=${target} failed:`, e.message);
  }

  throw new Error(`No SKUs found for style "${target}".`);
}

function summarizeSsStyle(skus) {
  const first = skus[0];
  const styleName = first.styleName;
  const brand = first.brandName;
  const titleCandidate = first.title || first.styleTitle || first.styleDescription || `${brand} ${styleName}`;

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

  const orderedSizes = sortSizes(sizeSet);

  return {
    styleName, brand,
    title: titleCandidate,
    minPrice: minPrice === Infinity ? null : minPrice,
    sizeRangeBottom: orderedSizes[0] || null,
    sizeRangeTop:    orderedSizes[orderedSizes.length - 1] || null,
    colors: [...colorMap.values()],
    ssStyleID: first.styleID,
  };
}

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
        { $set: { basePrice: summary.minPrice, priceRangeBottom, priceRangeTop,
            sizeRangeBottom: summary.sizeRangeBottom || 'S', sizeRangeTop: summary.sizeRangeTop || 'XL',
            rating: deriveRating(p.style), updatedAt: new Date() } }
      );
      updated++;
    } catch (e) {
      console.error(`[SS refresh] "${p.style}":`, e.message);
      failed.push({ style: p.style, reason: e.message });
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { updated, total: ssProducts.length, failed };
}

exports._refreshAllSSProducts = refreshAllSSProducts;

exports.refreshAllSSProductsHandler = async (req, res) => {
  try {
    const results = await refreshAllSSProducts();
    return res.status(200).json(results);
  } catch (err) {
    console.error('refreshAllSS error:', err);
    return res.status(500).json({ message: err.message || 'Refresh failed.' });
  }
};

exports.syncFromSS = async (req, res) => {
  try {
    ensureSsCredentials();
    const { styles, tag, markup, overrideCategory, overrideType } = req.body || {};
    if (!Array.isArray(styles) || styles.length === 0) return res.status(400).json({ message: 'Provide a non-empty `styles` array.' });
    if (styles.length > 50) return res.status(400).json({ message: 'Sync at most 50 styles per request.' });

    const markupNum = Number.isFinite(Number(markup)) && Number(markup) > 0 ? Number(markup) : PRICE_MARKUP;
    const tagToUse  = typeof tag === 'string' && tag ? tag : 'New Arrival';
    let created = 0, updated = 0;
    const products = [], failed = [];

    for (const styleName of styles) {
      try {
        const skus    = await fetchSSProducts(styleName);
        const summary = summarizeSsStyle(skus);
        const category = overrideCategory || detectCategory(summary.title);
        const type     = overrideType     || detectType(summary.title);
        const baseLo = (summary.minPrice || 8) * markupNum;
        const baseHi = baseLo * PRICE_SPREAD;
        const priceRangeBottom = roundDollar(baseLo);
        const priceRangeTop    = roundDollar(baseHi);

        const productFrontImages = [], productBackImages = [], colors = [], colorCodes = [];
        for (const c of summary.colors) {
          colors.push(c.name);
          colorCodes.push((c.hex || '#CCCCCC').toUpperCase());
          productFrontImages.push(c.front ? await uploadImageToGridFS(c.front) : null);
          productBackImages.push(c.back  ? await uploadImageToGridFS(c.back)  : null);
        }

        const update = {
          name: summary.title, vendor: summary.brand || 'S&S Activewear',
          brandName: summary.brand, style: summary.styleName, ssStyleID: summary.ssStyleID,
          source: 'ssactivewear', basePrice: summary.minPrice,
          description: `${summary.brand} ${summary.styleName} — ${summary.title}`,
          sizeRangeBottom: summary.sizeRangeBottom || 'S',
          sizeRangeTop:    summary.sizeRangeTop || 'XL',
          colors, colorCodes, productFrontImages, productBackImages,
          rating: deriveRating(summary.styleName), tag: tagToUse,
          category, type, priceRangeBottom, priceRangeTop,
        };

        const existing = await Product.findOne({ style: summary.styleName });
        let saved;
        if (existing) {
          delete update.priceRangeBottom;
          delete update.priceRangeTop;
          Object.assign(existing, update);
          saved = await existing.save();
          updated++;
        } else {
          saved = await Product.create(update);
          created++;
        }
        products.push({ style: saved.style, name: saved.name, vendor: saved.vendor, category: saved.category, type: saved.type });
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

exports.createProduct = exports.createProductFromAlphaBroder;

// ─────────────────────────────────────────────────────────────────────────────
//  importFromJson
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_CATEGORIES = ['T-Shirts', 'Long Sleeve', 'Hoodies', 'Crewnecks', 'Zip-Ups', 'Tanks', 'Polos', 'Jackets', 'Pants', 'Shorts', 'Hats', 'Promo'];
const ALLOWED_TYPES = ['Unisex', 'Male', 'Female', 'Kids'];
const ALLOWED_TAGS  = ['Best Seller', 'New Arrival', 'Clearance', 'Our Favorite', 'Exclusive'];

function safeNumber(v, fallback) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; }
function safeString(v, fallback = '') { if (typeof v !== 'string') return fallback; return v.trim() || fallback; }
function pickFromList(v, list, fallback) { if (typeof v !== 'string') return fallback; return list.find((x) => x.toLowerCase() === v.trim().toLowerCase()) || fallback; }
function safeArray(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }

exports.importFromJson = async (req, res) => {
  try {
    const { products: rawProducts, defaultTag, defaultCategory } = req.body || {};
    if (!Array.isArray(rawProducts) || rawProducts.length === 0) return res.status(400).json({ message: 'Provide a non-empty `products` array.' });
    if (rawProducts.length > 200) return res.status(400).json({ message: 'Import at most 200 products per request.' });

    const fallbackTag      = pickFromList(defaultTag, ALLOWED_TAGS, 'New Arrival');
    const fallbackCategory = pickFromList(defaultCategory, ALLOWED_CATEGORIES, 'Promo');
    let created = 0, updated = 0;
    const products = [], failed = [];

    for (let i = 0; i < rawProducts.length; i++) {
      const raw = rawProducts[i] || {};
      try {
        const style = safeString(raw.style || raw.styleCode || raw.sku);
        if (!style) { failed.push({ style: `item #${i + 1}`, reason: 'Missing required field "style"' }); continue; }

        const name             = safeString(raw.name || raw.title, `Product ${style}`);
        const vendor           = safeString(raw.vendor || raw.brand || raw.brandName, 'Joint Printing');
        const description      = safeString(raw.description, `${vendor} ${name}`);
        const category         = pickFromList(raw.category, ALLOWED_CATEGORIES, fallbackCategory);
        const type             = pickFromList(raw.type || raw.fit, ALLOWED_TYPES, 'Unisex');
        const tag              = pickFromList(raw.tag, ALLOWED_TAGS, fallbackTag);
        const rating           = Math.max(1, Math.min(5, Math.round(safeNumber(raw.rating, 5))));
        const priceRangeBottom = safeNumber(raw.priceRangeBottom || raw.priceMin || raw.minPrice, 5);
        const priceRangeTop    = safeNumber(raw.priceRangeTop    || raw.priceMax || raw.maxPrice, Math.max(priceRangeBottom + 5, 15));
        const sizeRangeBottom  = safeString(raw.sizeRangeBottom || raw.sizeMin, 'OS');
        const sizeRangeTop     = safeString(raw.sizeRangeTop    || raw.sizeMax, sizeRangeBottom);

        const colors     = safeArray(raw.colors).map((c) => String(c)).filter(Boolean);
        const colorCodes = safeArray(raw.colorCodes).map((c) => { let s = String(c).trim(); if (s && !s.startsWith('#')) s = '#' + s; return s.toUpperCase(); });
        while (colorCodes.length < colors.length) colorCodes.push('#CCCCCC');
        if (colors.length === 0) { colors.push('Black'); colorCodes.push('#000000'); }

        const imageUrls         = safeArray(raw.imageUrls || raw.images);
        const productFrontImages = [];
        for (const url of imageUrls.slice(0, colors.length || 1)) {
          try { productFrontImages.push(await uploadImageToGridFS(url)); } catch (_) { productFrontImages.push(null); }
        }
        while (productFrontImages.length < colors.length) productFrontImages.push(null);
        const productBackImages = colors.map(() => null);

        const update = { name, vendor, style, description, source: 'manual', sizeRangeBottom, sizeRangeTop, colors, colorCodes, productFrontImages, productBackImages, rating, tag, category, type, priceRangeBottom, priceRangeTop };
        const existing = await Product.findOne({ style });
        let saved;
        if (existing) { Object.assign(existing, update); saved = await existing.save(); updated++; }
        else { saved = await Product.create(update); created++; }
        products.push({ style: saved.style, name: saved.name, vendor: saved.vendor, category: saved.category, type: saved.type });
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

// ─── S&S Live Browse ──────────────────────────────────────────────────────────
const _ssCache         = new Map();
const _ssDetailsCache  = new Map();
const _ssImageCache    = new Map();
const SS_CACHE_TTL          = 4 * 60 * 60 * 1000;
const SS_DETAILS_CACHE_TTL  = 12 * 60 * 60 * 1000;
const SS_IMAGE_CACHE_TTL    = 12 * 60 * 60 * 1000;

async function fetchStyleImage(styleName) {
  const cached = _ssImageCache.get(styleName);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  try {
    const { data } = await ssClient.get('/styles/', {
      params: { style: styleName },
      timeout: 10_000,
    });
    const normalizedTarget = styleName.trim().toLowerCase();
    const matching = Array.isArray(data)
      ? (data.find((s) => (s.styleName || '').trim().toLowerCase() === normalizedTarget) || data[0])
      : null;
    const url = ssImageUrl(pickSSImagePath(matching));
    _ssImageCache.set(styleName, { url, expiresAt: Date.now() + SS_IMAGE_CACHE_TTL });
    return url;
  } catch (_) {
    return null;
  }
}

exports.getSSImages = async (req, res) => {
  try {
    ensureSsCredentials();
    const { styles } = req.query;
    if (!styles) return res.json({ images: {} });

    const styleList = String(styles).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const results = await Promise.allSettled(
      styleList.map(async (style) => {
        const url = await fetchStyleImage(style);
        return { style, url };
      })
    );

    const images = {};
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.url) {
        images[r.value.style] = r.value.url;
      }
    }

    return res.json({ images });
  } catch (err) {
    console.error('getSSImages error:', err.message);
    return res.status(500).json({ message: err.message });
  }
};

const SS_POPULAR_BRANDS = [
  'Bella + Canvas', 'Gildan', 'Port & Company', 'Port Authority',
  'Sport-Tek', 'Next Level', 'Alternative Apparel', 'Hanes',
  'District', 'Carhartt', 'Jerzees', 'Champion',
  'Independent Trading Co.', 'Comfort Colors', 'LAT Apparel',
];

const SS_FEATURED_BRANDS = [
  'Gildan',
  'Bella + Canvas',
  'Next Level',
  'Hanes',
];

async function fetchAndGroupSSBrand(brand) {
  const cacheKey = `brand:${brand}`;
  const cached   = _ssCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const { data } = await ssClient.get('/styles/', {
    params: { brand },
    timeout: 30_000,
  });

  if (!Array.isArray(data)) {
    const detail = data?.Message || data?.message || JSON.stringify(data).slice(0, 200);
    console.error(`[fetchAndGroupSSBrand] S&S returned non-array for brand "${brand}":`, detail);
    throw new Error(`S&S catalog unavailable for brand "${brand}". (${detail})`);
  }

  if (data.length === 0) {
    console.warn(`[fetchAndGroupSSBrand] S&S returned 0 styles for brand "${brand}" — not caching`);
    throw new Error(`S&S returned no styles for brand "${brand}". Check SS_ACCOUNT / SS_API_KEY env vars.`);
  }

  if (!fetchAndGroupSSBrand._fieldsLogged) {
    fetchAndGroupSSBrand._fieldsLogged = true;
    console.log('[S&S /styles/ available fields]:', Object.keys(data[0]).join(', '));
  }

  const styles = [];
  for (const style of data) {
    const title = style.title || style.styleTitle || style.styleDescription
      || `${style.brandName || brand} ${style.styleName}`;
    const imageUrl = ssImageUrl(pickSSImagePath(style));

    if (imageUrl) {
      _ssImageCache.set(style.styleName, { url: imageUrl, expiresAt: Date.now() + SS_IMAGE_CACHE_TTL });
    }

    styles.push({
      style: style.styleName,
      name: title,
      vendor: style.brandName || brand,
      category: detectCategory(title),
      type: detectType(title),
      priceRangeBottom: null,
      priceRangeTop: null,
      sizeRangeBottom: null,
      sizeRangeTop: null,
      colorCount: style.colorCount || 0,
      rating: deriveRating(style.styleName),
      tag: deriveTag(style.brandName || brand, title),
      image: imageUrl,
    });
  }

  styles.sort((a, b) => a.style.localeCompare(b.style));
  const result = { styles, total: styles.length };
  _ssCache.set(cacheKey, { data: result, expiresAt: Date.now() + SS_CACHE_TTL });
  return result;
}

async function fetchAllSSBrands() {
  const cacheKey = 'all-brands';
  const cached   = _ssCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const results = await Promise.allSettled(
    SS_FEATURED_BRANDS.map((brand) => fetchAndGroupSSBrand(brand))
  );

  const seenStyles = new Set();
  const allStyles  = [];
  const errors     = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const s of r.value.styles) {
        if (!seenStyles.has(s.style)) { seenStyles.add(s.style); allStyles.push(s); }
      }
    } else {
      errors.push(r.reason?.message || 'Unknown error');
      console.error('[fetchAllSSBrands] brand failed:', r.reason?.message);
    }
  }

  if (allStyles.length === 0) {
    const detail = errors.length ? errors[0] : 'All brand requests failed.';
    throw new Error(`Could not load the product catalog. ${detail}`);
  }

  allStyles.sort((a, b) => {
    const aPri = SS_FEATURED_BRANDS.findIndex((bp) => (a.vendor || '').toLowerCase().includes(bp.toLowerCase()));
    const bPri = SS_FEATURED_BRANDS.findIndex((bp) => (b.vendor || '').toLowerCase().includes(bp.toLowerCase()));
    const ai = aPri === -1 ? SS_FEATURED_BRANDS.length : aPri;
    const bi = bPri === -1 ? SS_FEATURED_BRANDS.length : bPri;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
  const data = { styles: allStyles, total: allStyles.length };
  _ssCache.set(cacheKey, { data, expiresAt: Date.now() + SS_CACHE_TTL });
  return data;
}

exports.warmSSCache = () => {
  if (!SS_ACCOUNT || !SS_API_KEY) return;
  console.log('[SS] Starting background cache warm-up…');
  fetchAllSSBrands()
    .then((d) => console.log(`[SS] Cache warm-up done — ${d.total} styles cached.`))
    .catch((e) => console.warn('[SS] Cache warm-up failed:', e.message));
};

exports.browseSS = async (req, res) => {
  try {
    ensureSsCredentials();
    const { brand, page = 1, limit = 24, search = '', category = '', type = '' } = req.query;

    const result = brand ? await fetchAndGroupSSBrand(brand) : await fetchAllSSBrands();
    let { styles } = result;

    if (category) styles = styles.filter((s) => s.category === category);
    if (type)     styles = styles.filter((s) => s.type === type);
    if (search) {
      const q = search.toLowerCase();
      styles = styles.filter((s) => s.name.toLowerCase().includes(q) || s.style.toLowerCase().includes(q));
    }

    const total = styles.length;
    const p = Math.max(1, parseInt(page, 10));
    const l = Math.min(48, Math.max(1, parseInt(limit, 10)));
    const start = (p - 1) * l;

    const pageSlice = styles.slice(start, start + l).map((s) => {
      const cached = _ssDetailsCache.get(s.style);
      if (cached && cached.expiresAt > Date.now()) {
        const { priceRangeBottom, priceRangeTop } = deriveRange(cached.minPrice);
        return {
          ...s,
          priceRangeBottom,
          priceRangeTop,
          sizeRangeBottom: cached.sizeRangeBottom,
          sizeRangeTop: cached.sizeRangeTop,
          colorCount: cached.colorCount || s.colorCount,
        };
      }
      return s;
    });

    return res.json({ products: pageSlice, total, page: p, totalPages: Math.ceil(total / l) });
  } catch (err) {
    console.error('browseSS error:', err.message);
    return res.status(500).json({ message: err.message || 'Browse failed.' });
  }
};

exports.getSSBrands = (_req, res) => {
  res.json({ brands: SS_POPULAR_BRANDS });
};

exports.testSSConnection = async (req, res) => {
  const account = SS_ACCOUNT ? `${SS_ACCOUNT.slice(0, 3)}***` : '(not set)';
  const keySet  = !!SS_API_KEY;
  if (!SS_ACCOUNT || !SS_API_KEY) {
    return res.status(200).json({ ok: false, account, keySet, error: 'Credentials missing' });
  }
  try {
    const { data } = await ssClient.get('/styles/', {
      params: { brand: 'Gildan' },
      timeout: 15_000,
    });
    if (!Array.isArray(data)) {
      return res.status(200).json({ ok: false, account, keySet, error: 'S&S returned non-array', sample: JSON.stringify(data).slice(0, 300) });
    }
    return res.status(200).json({
      ok: true, account, keySet,
      styleCount: data.length,
      sampleStyle: data[0]?.styleName || null,
      sampleFields: data[0] ? Object.keys(data[0]).slice(0, 15) : [],
    });
  } catch (err) {
    return res.status(200).json({ ok: false, account, keySet, error: err.message });
  }
};

async function fetchStyleDetails(styleName) {
  const cached = _ssDetailsCache.get(styleName);
  if (cached && cached.expiresAt > Date.now()) return cached;

  try {
    const skus = await fetchSSProducts(styleName);
    const summary = summarizeSsStyle(skus);
    const entry = {
      minPrice: summary.minPrice,
      sizeRangeBottom: summary.sizeRangeBottom,
      sizeRangeTop: summary.sizeRangeTop,
      colors: summary.colors,
      colorCount: summary.colors.length,
      title: summary.title,
      brand: summary.brand,
      expiresAt: Date.now() + SS_DETAILS_CACHE_TTL,
    };
    _ssDetailsCache.set(styleName, entry);
    return entry;
  } catch (e) {
    console.warn(`[fetchStyleDetails] "${styleName}" failed:`, e.message);
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = { _error: e?.message || 'error' }; }
    }
  }
  const lanes = Array(Math.min(concurrency, items.length)).fill(0).map(next);
  await Promise.all(lanes);
  return results;
}

exports.getSSDetails = async (req, res) => {
  try {
    ensureSsCredentials();
    const { styles } = req.query;
    if (!styles) return res.json({ details: {} });

    const styleList = String(styles)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);

    const results = await mapWithConcurrency(styleList, 6, async (styleName) => {
      const d = await fetchStyleDetails(styleName);
      if (!d) return null;
      const { priceRangeBottom, priceRangeTop } = deriveRange(d.minPrice);
      return {
        style: styleName,
        priceRangeBottom,
        priceRangeTop,
        sizeRangeBottom: d.sizeRangeBottom,
        sizeRangeTop: d.sizeRangeTop,
        colorCount: d.colorCount,
      };
    });

    const details = {};
    for (const r of results) {
      if (r && r.style) details[r.style] = r;
    }
    return res.json({ details });
  } catch (err) {
    console.error('getSSDetails error:', err.message);
    return res.status(500).json({ message: err.message });
  }
};

exports.getSSStyleDetail = async (req, res) => {
  try {
    ensureSsCredentials();
    const styleName = req.params.style;

    let basicInfo = null;
    try {
      const { data: stylesData } = await ssClient.get('/styles/', {
        params: { style: styleName },
        timeout: 10_000,
      });
      const match = Array.isArray(stylesData)
        ? (stylesData.find((s) => (s.styleName || '').trim().toLowerCase() === styleName.trim().toLowerCase())
            || stylesData[0])
        : null;
      if (match) {
        const title = match.title || match.styleTitle || match.styleDescription
          || `${match.brandName || ''} ${match.styleName || styleName}`.trim();
        const brand = match.brandName || 'S&S Activewear';
        basicInfo = {
          styleName: match.styleName || styleName,
          brand,
          title,
          description: match.description || `${brand} ${match.styleName || styleName}`,
          image: ssImageUrl(pickSSImagePath(match)),
        };
      }
    } catch (e) {
      console.warn(`[getSSStyleDetail] /styles/ lookup failed for "${styleName}":`, e.message);
    }

    const details = await fetchStyleDetails(styleName);

    if (!basicInfo && !details) {
      return res.status(404).json({ message: `Could not find style "${styleName}".` });
    }

    const title = basicInfo?.title || details?.title || styleName;
    const brand = basicInfo?.brand || details?.brand || 'S&S Activewear';
    const { priceRangeBottom, priceRangeTop } = details ? deriveRange(details.minPrice) : { priceRangeBottom: null, priceRangeTop: null };

    const colors = details?.colors || [];
    const productFrontImages = colors.length
      ? colors.map((c) => c.front || null)
      : (basicInfo?.image ? [basicInfo.image] : []);

    return res.json({
      style: styleName,
      name: title,
      vendor: brand,
      category: detectCategory(title),
      type: detectType(title),
      priceRangeBottom,
      priceRangeTop,
      sizeRangeBottom: details?.sizeRangeBottom ?? null,
      sizeRangeTop: details?.sizeRangeTop ?? null,
      colors: colors.map((c) => c.name),
      colorCodes: colors.map((c) => (c.hex || '#CCCCCC').toUpperCase()),
      productFrontImages,
      productBackImages: colors.map((c) => c.back || null),
      rating: deriveRating(styleName),
      tag: deriveTag(brand, title),
      description: basicInfo?.description || `${brand} ${styleName} — ${title}`,
    });
  } catch (err) {
    console.error('getSSStyleDetail error:', err.message);
    return res.status(500).json({ message: err.message || 'Could not fetch style detail.' });
  }
};
