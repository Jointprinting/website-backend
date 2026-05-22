// controllers/product.js
require('dotenv').config();

const xml2js = require('xml2js');
const axios = require('axios');
const mongoose = require('mongoose');
const sharp = require('sharp');
const Product = require('../models/Product');
const { getGfs } = require('../gridfs');

// ─────────────────────────────────────────────────────────────────────────────
//  Pricing — "Starting at $X"
// ─────────────────────────────────────────────────────────────────────────────
const BLANK_MARKUP = 1.6;

const CATEGORY_MIN_PRICE = {
  'T-Shirts':    7,  'Long Sleeve': 9,  'Tanks':       7,
  'Polos':       14, 'Hoodies':     16, 'Zip-Ups':     20,
  'Crewnecks':   14, 'Jackets':     30, 'Pants':       14,
  'Shorts':      11, 'Hats':        8,
};

function startingAt(basePrice, category) {
  const floor = CATEGORY_MIN_PRICE[category] != null ? CATEGORY_MIN_PRICE[category] : 8;
  const computed = (typeof basePrice === 'number' && basePrice > 0)
    ? Math.round(basePrice * BLANK_MARKUP)
    : 0;
  return Math.max(floor, computed);
}

function defaultSizeRange(title, category, type) {
  const t = (title || '').toLowerCase();
  if (category === 'Hats')                                                       return { sizeRangeBottom: 'One Size', sizeRangeTop: 'One Size' };
  if (/\binfant\b|\bbaby\b|\bonesie\b|one[-\s]?piece/.test(t))                   return { sizeRangeBottom: 'NB',       sizeRangeTop: '24M'      };
  if (/\btoddler\b/.test(t))                                                     return { sizeRangeBottom: '2T',       sizeRangeTop: '5/6'      };
  if (type === 'Kids' || /\byouth\b|\bjunior\b/.test(t))                         return { sizeRangeBottom: 'XS',       sizeRangeTop: 'XL'       };
  if (/\btall\b/.test(t))                                                        return { sizeRangeBottom: 'LT',       sizeRangeTop: '3XLT'     };
  if (type === 'Female' || /\bladies\b|\bwomens?\b|\bwoman\b/.test(t))           return { sizeRangeBottom: 'XS',       sizeRangeTop: '2XL'      };
  return { sizeRangeBottom: 'S', sizeRangeTop: '3XL' };
}

const CATEGORY_DESCRIPTIONS = {
  'T-Shirts':    'A classic short-sleeve t-shirt available in multiple colors and sizes. Perfect for screen printing or embroidery on the front, back, or sleeves.',
  'Long Sleeve': 'A versatile long-sleeve tee designed for layering or year-round wear. Ideal for custom printing or embroidery.',
  'Tanks':       'A breathable sleeveless tank top available in multiple colors. Great for team apparel, summer events, and printing on the front or back.',
  'Polos':       'A polished short-sleeve polo with a button placket. Excellent for team uniforms, corporate apparel, and embroidered logos.',
  'Hoodies':     'A cozy pullover hoodie with a roomy front pocket. Perfect for screen printing on the chest or back, or embroidery on the front.',
  'Zip-Ups':     'A full-zip hoodie that layers easily and shows off custom designs front and back. Ideal for team apparel and branded merch.',
  'Crewnecks':   'A classic crewneck sweatshirt — comfortable, durable, and ready for printing or embroidery. Available in a wide range of colors.',
  'Jackets':     'A weather-ready jacket built for durability. Great for company uniforms, team outerwear, and embroidered branding.',
  'Pants':       'Comfortable pants designed for fit and movement. Perfect for team uniforms or branded apparel with custom prints or embroidery.',
  'Shorts':      'Versatile athletic shorts available in multiple colors. Great for sports teams, summer events, or casual branded apparel.',
  'Hats':        'A structured cap available in multiple colors and styles. Ideal for embroidered logos, custom prints, and event giveaways.',
};

const PREMIUM_BRANDS     = ['bella', 'canvas', 'next level', 'alternative', 'district', 'american apparel'];
const POPULAR_BRANDS_TAG = ['gildan', 'port', 'hanes', 'jerzees', 'sport-tek', 'carhartt'];

function deriveRating(styleName = '') {
  let h = 0;
  for (let i = 0; i < styleName.length; i++) h = (h * 31 + styleName.charCodeAt(i)) | 0;
  const r = ((Math.abs(h) % 11) / 10) + 4;
  return Math.round(r * 2) / 2;
}

function deriveTag(brand = '', styleName = '') {
  const b = brand.toLowerCase();
  if (PREMIUM_BRANDS.some(p => b.includes(p))) return 'Our Favorite';
  if (POPULAR_BRANDS_TAG.some(p => b.includes(p))) return 'Best Seller';
  return 'New Arrival';
}

function extractAlphaBroderMinPrice(item) {
  const PRICE_FIELDS = ['piecePrice', 'pieceprice', 'priceperpiece', 'basepriceperpiece', 'basePricePerPiece', 'baseprice', 'basePrice', 'piecedirectprice', 'price'];
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
//  S&S constants
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
    throw new Error('S&S Activewear credentials are not configured.');
  }
}

function ssImageUrl(relPath) {
  if (!relPath) return null;
  if (relPath.startsWith('http')) return relPath;
  return SS_CDN_BASE + relPath.replace(/^\/+/, '');
}

function pickSSImagePath(row) {
  if (!row) return null;
  return row.image || row.colorFrontImage || row.styleImage || row.styleImageFront || row.frontImage || null;
}

function detectCategory(name = '') {
  const n = name.toLowerCase();
  if (/(full[-\s]?zip|zip[-\s]?up)/.test(n))                                   return 'Zip-Ups';
  if (/(hoodie|hooded)/.test(n))                                                return 'Hoodies';
  if (/(crewneck|crew[-\s]?neck|sweatshirt|fleece|sherpa)/.test(n))            return 'Crewnecks';
  if (/(tank|sleeveless|muscle)/.test(n))                                       return 'Tanks';
  if (/\bpolo\b/.test(n))                                                       return 'Polos';
  if (/(jacket|windbreaker|softshell|anorak|parka|vest|bomber|rain)/.test(n))  return 'Jackets';
  if (/(long[-\s]?sleeve|ls\b)/.test(n))                                       return 'Long Sleeve';
  if (/\bshort[s]?\b/.test(n))                                                  return 'Shorts';
  if (/(pant|jogger|sweatpant|legging|trouser)/.test(n))                       return 'Pants';
  if (/(cap|hat|beanie|trucker|snapback|bucket|visor)/.test(n))                return 'Hats';
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
//  GridFS helpers (legacy AlphaBroder path only — S&S doesn't use GridFS)
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
    console.error(`Error fetching image: ${imageUrl}`, err.message);
    return null;
  }
}

async function getImageFromGridFS(imageId) {
  if (!imageId) return null;
  return new Promise((resolve) => {
    const gfs = getGfs();
    const downloadStream = gfs.openDownloadStream(imageId);
    const chunks = [];
    downloadStream.on('data', (chunk) => chunks.push(chunk));
    downloadStream.on('end', () => {
      resolve(`data:image/webp;base64,${Buffer.concat(chunks).toString('base64')}`);
    });
    downloadStream.on('error', (err) => {
      console.error(`GridFS read failed for ${imageId}:`, err.message);
      resolve(null);
    });
  });
}

async function populateImages(product) {
  const obj = product.toObject ? product.toObject() : product;
  const resolve = async (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    return getImageFromGridFS(v);
  };
  return {
    ...obj,
    productFrontImages: await Promise.all((obj.productFrontImages || []).map(resolve)),
    productBackImages:  await Promise.all((obj.productBackImages  || []).map(resolve)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mongo read endpoints
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
      products.map(async (product) => {
        const obj = product.toObject();
        const front = obj.productFrontImages?.[0];
        const back  = obj.productBackImages?.[0];
        return {
          ...obj,
          productFrontImages: [typeof front === 'string' ? front : await getImageFromGridFS(front)],
          productBackImages:  [typeof back  === 'string' ? back  : await getImageFromGridFS(back)],
        };
      })
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
//  AlphaBroder XML add (unchanged behaviour — still uses GridFS for its own
//  images because we have AB credentials and the path works)
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
  const category   = req.body.category || detectCategory(name);

  const product = new Product({
    name, vendor, style, description,
    sizeRangeBottom: sizeNames[0] || null,
    sizeRangeTop:    sizeNames[sizeNames.length - 1] || null,
    colors: colorArray, colorCodes,
    productFrontImages, productBackImages,
    category,
    priceFrom: startingAt(xmlMinPrice, category),
    basePrice: xmlMinPrice || undefined,
    rating: req.body.rating || 5,
    tag: req.body.tag || 'New Arrival',
    type: req.body.type,
    source: 'alphabroder',
  });

  await product.save();
  return product;
}

function capitalizeWords(s = '') {
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

exports.createProduct = exports.createProductFromAlphaBroder;

// ─────────────────────────────────────────────────────────────────────────────
//  importFromJson (admin)
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

        const name      = safeString(raw.name || raw.title, `Product ${style}`);
        const vendor    = safeString(raw.vendor || raw.brand || raw.brandName, 'Joint Printing');
        const description = safeString(raw.description, `${vendor} ${name}`);
        const category  = pickFromList(raw.category, ALLOWED_CATEGORIES, fallbackCategory);
        const type      = pickFromList(raw.type || raw.fit, ALLOWED_TYPES, 'Unisex');
        const tag       = pickFromList(raw.tag, ALLOWED_TAGS, fallbackTag);
        const rating    = Math.max(1, Math.min(5, Math.round(safeNumber(raw.rating, 5))));
        const basePrice = safeNumber(raw.basePrice || raw.minPrice, null);
        const priceFrom = safeNumber(raw.priceFrom, startingAt(basePrice, category));
        const sizeRangeBottom = safeString(raw.sizeRangeBottom || raw.sizeMin, null) || null;
        const sizeRangeTop    = safeString(raw.sizeRangeTop    || raw.sizeMax, null) || sizeRangeBottom;

        const colors     = safeArray(raw.colors).map((c) => String(c)).filter(Boolean);
        const colorCodes = safeArray(raw.colorCodes).map((c) => { let s = String(c).trim(); if (s && !s.startsWith('#')) s = '#' + s; return s.toUpperCase(); });
        while (colorCodes.length < colors.length) colorCodes.push('#CCCCCC');
        if (colors.length === 0) { colors.push('Black'); colorCodes.push('#000000'); }

        const imageUrls = safeArray(raw.imageUrls || raw.images);
        const productFrontImages = imageUrls.slice(0, colors.length || 1);
        while (productFrontImages.length < colors.length) productFrontImages.push(null);
        const productBackImages = colors.map(() => null);

        const update = { name, vendor, style, description, source: 'manual', sizeRangeBottom, sizeRangeTop, colors, colorCodes, productFrontImages, productBackImages, rating, tag, category, type, priceFrom, basePrice };
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

// ─────────────────────────────────────────────────────────────────────────────
//  S&S Activewear data layer — /styles/ only (the only endpoint that works
//  for our account; /products/ returns 404 across the board).
//
//  /styles/?brand=X is reliable. /styles/?style=X is BROKEN — it ignores the
//  filter and returns the full catalog, so we never use it. Detail lookups
//  go through brand caches we already populate.
// ─────────────────────────────────────────────────────────────────────────────
const _ssCache = new Map();
const SS_CACHE_TTL = 4 * 60 * 60 * 1000;

const SS_POPULAR_BRANDS = [
  'Bella + Canvas', 'Gildan', 'Port & Company', 'Port Authority',
  'Sport-Tek', 'Next Level', 'Alternative Apparel', 'Hanes',
  'District', 'Carhartt', 'Jerzees', 'Champion',
  'Independent Trading Co.', 'Comfort Colors', 'LAT Apparel',
];

const SS_FEATURED_BRANDS = [
  'Gildan', 'Bella + Canvas', 'Next Level', 'Hanes',
];

exports._getSSPopularBrands = () => [...SS_POPULAR_BRANDS];

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
    throw new Error(`S&S catalog unavailable for "${brand}". (${detail})`);
  }
  if (data.length === 0) {
    throw new Error(`S&S returned no styles for "${brand}".`);
  }

  const styles = [];
  for (const style of data) {
    const title    = style.title || style.styleTitle || style.styleDescription
                  || `${style.brandName || brand} ${style.styleName}`;
    const imageUrl = ssImageUrl(pickSSImagePath(style));
    const vendor   = style.brandName || brand;
    const category = detectCategory(title);
    const type     = detectType(title);
    const { sizeRangeBottom, sizeRangeTop } = defaultSizeRange(title, category, type);
    const description = style.description || CATEGORY_DESCRIPTIONS[category] || `${vendor} ${style.styleName}`;

    styles.push({
      style:        style.styleName,
      styleID:      style.styleID,
      partNumber:   style.partNumber,
      name:         title,
      vendor,
      category,
      type,
      priceFrom:    startingAt(null, category),
      sizeRangeBottom, sizeRangeTop,
      colorCount:   style.colorCount || 0,
      rating:       deriveRating(style.styleName),
      tag:          deriveTag(vendor, title),
      image:        imageUrl,
      description,
    });
  }

  styles.sort((a, b) => a.style.localeCompare(b.style));
  const result = { styles, total: styles.length };
  _ssCache.set(cacheKey, { data: result, expiresAt: Date.now() + SS_CACHE_TTL });
  return result;
}

exports._fetchSSBrandStyles = fetchAndGroupSSBrand;

async function fetchAllSSBrands() {
  const cacheKey = 'all-brands';
  const cached   = _ssCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const results = await Promise.allSettled(
    SS_FEATURED_BRANDS.map((brand) => fetchAndGroupSSBrand(brand))
  );

  const seen = new Set();
  const allStyles = [];
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const s of r.value.styles) {
        if (!seen.has(s.style)) { seen.add(s.style); allStyles.push(s); }
      }
    } else {
      errors.push(r.reason?.message || 'Unknown error');
    }
  }
  if (allStyles.length === 0) {
    throw new Error(`Could not load the product catalog. ${errors[0] || 'All brand requests failed.'}`);
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

// Cross-brand style finder — walks the featured brands' cached catalogs
// first (covers ~95% of clicks), falls back to other popular brands.
// Replaces the broken /styles/?style=X lookup.
async function findStyleByName(styleName) {
  // S&S strips brand-letter prefixes from styleNames: marketing "G500" is
  // stored as "5000", "G2000" as "2000", "G185" as "18500". The mapping
  // isn't a single rule, so we try a small variant set and take the first
  // exact match.
  const raw = String(styleName || '').trim();
  const variants = new Set();
  const add = (v) => { if (v) variants.add(String(v).toLowerCase().trim()); };
  add(raw);
  const m = raw.match(/^([A-Za-z])(\d.*)$/);
  if (m) {
    const stripped = m[2];
    add(stripped);        // G500 -> 500
    add(stripped + '0');  // G500 -> 5000
    add(stripped + '00'); // G50  -> 5000
  }

  const findMatch = (haystack) => {
    for (const v of variants) {
      const hit = haystack.find((s) =>
        String(s.style || s.styleName || '').toLowerCase() === v ||
        String(s.partNumber || '').toLowerCase() === v
      );
      if (hit) return hit;
    }
    return null;
  };

  try {
    const all = await fetchAllSSBrands();
    const hit = findMatch(all.styles);
    if (hit) return hit;
  } catch (_) {}

  for (const brand of SS_POPULAR_BRANDS) {
    if (SS_FEATURED_BRANDS.includes(brand)) continue;
    try {
      const result = await fetchAndGroupSSBrand(brand);
      const hit = findMatch(result.styles);
      if (hit) return hit;
    } catch (_) {}
  }
  return null;
}

exports.warmSSCache = () => {
  if (!SS_ACCOUNT || !SS_API_KEY) return;
  console.log('[SS] Starting background /styles/ cache warm…');
  fetchAllSSBrands()
    .then((d) => console.log(`[SS] /styles/ cache warm done — ${d.total} styles.`))
    .catch((e) => console.warn('[SS] /styles/ cache warm failed:', e.message));
};

// ─────────────────────────────────────────────────────────────────────────────
//  Public S&S endpoints
// ─────────────────────────────────────────────────────────────────────────────
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
    const { data } = await ssClient.get('/styles/', { params: { brand: 'Gildan' }, timeout: 15_000 });
    if (!Array.isArray(data)) {
      return res.status(200).json({ ok: false, account, keySet, error: 'Non-array response', sample: JSON.stringify(data).slice(0, 300) });
    }
    return res.status(200).json({
      ok: true, account, keySet, styleCount: data.length,
      sampleStyle: data[0]?.styleName || null,
      sampleStyleID: data[0]?.styleID || null,
    });
  } catch (err) {
    return res.status(200).json({ ok: false, account, keySet, error: err.message });
  }
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
    const pageSlice = styles.slice(start, start + l);

    return res.json({ products: pageSlice, total, page: p, totalPages: Math.ceil(total / l) });
  } catch (err) {
    console.error('browseSS error:', err.message);
    return res.status(500).json({ message: err.message || 'Browse failed.' });
  }
};

// Detail handler — Mongo override first (admin-curated), then /styles/
// brand-cache lookup. NO sync attempt on /products/ since that endpoint
// returns 404 for our account. Returns dataQuality:'styles-only' so the
// frontend can show a 'live colors come at quote time' note.
// Resolve a style code -> { match, summary } from S&S. Cached for 10 min so
// repeat detail-page hits don't re-scan 5,736 styles + re-fetch SKU rows.
async function resolveSSEnrichment(styleName) {
  const cacheKey = `enrich:${String(styleName || '').toLowerCase()}`;
  const cached = _ssCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  let data = null;
  try {
    const match = await findStyleByName(styleName);
    if (match) {
      const skus = await fetchSSProducts(null, match.styleID);
      const summary = summarizeSsStyle(skus);
      data = { match, summary };
    }
  } catch (e) {
    console.warn(`[SS] enrichment failed for "${styleName}":`, e.message);
  }
  _ssCache.set(cacheKey, { data, expiresAt: Date.now() + 10 * 60 * 1000 });
  return data;
}

exports.getProductByStyleCode = async (req, res) => {
  try {
    const styleName = req.params.style;

    // Always probe S&S so we can overlay real color/size data onto the
    // (possibly bare) Mongo record below. Cached, so cost is one slow call
    // every 10 minutes per style.
    const enrichment = await resolveSSEnrichment(styleName);
    const summary    = enrichment?.summary;
    const match      = enrichment?.match;

    const stored = await Product.findOne({ style: styleName });

    if (stored) {
      const base = await populateImages(stored);
      if (summary) {
        // Mongo keeps authority over name/description/price/tag. S&S takes
        // authority over colors/sizes/per-color photos — those are objective
        // and the Mongo import had them blank or stale.
        const baseFrontFiltered = (base.productFrontImages || []).filter(Boolean);
        const liveFront = summary.colors.find((c) => c.front)?.front;
        return res.status(200).json({
          ...base,
          ssStyleID:           match.styleID,
          colors:              summary.colors.map((c) => c.name),
          colorCodes:          summary.colors.map((c) => c.hex),
          colorSwatches:       summary.colors,
          sizes:               summary.sizes,
          sizeRangeBottom:     summary.sizeRangeBottom || base.sizeRangeBottom,
          sizeRangeTop:        summary.sizeRangeTop    || base.sizeRangeTop,
          productFrontImages:  baseFrontFiltered.length > 0
                                 ? baseFrontFiltered
                                 : (liveFront ? [liveFront] : []),
          colorCount:          summary.colors.length,
          dataQuality:         'mongo+live-products',
        });
      }
      return res.status(200).json(base);
    }

    if (!match) {
      return res.status(404).json({ message: `Could not find style "${styleName}".` });
    }

    const liveFront = summary?.colors?.find((c) => c.front)?.front;
    return res.json({
      style:               match.style,
      ssStyleID:           match.styleID,
      name:                summary?.title || match.name,
      vendor:              summary?.brand || match.vendor,
      category:            match.category,
      type:                match.type,
      priceFrom:           summary?.minPrice != null ? startingAt(summary.minPrice, match.category) : match.priceFrom,
      sizeRangeBottom:     summary?.sizeRangeBottom ?? null,
      sizeRangeTop:        summary?.sizeRangeTop    ?? null,
      sizes:               summary?.sizes  || [],
      colors:              summary?.colors?.map((c) => c.name) || [],
      colorCodes:          summary?.colors?.map((c) => c.hex)  || [],
      colorSwatches:       summary?.colors || [],
      productFrontImages:  liveFront ? [liveFront] : (match.image ? [match.image] : []),
      productBackImages:   [],
      colorCount:          summary?.colors?.length ?? match.colorCount,
      rating:              match.rating,
      tag:                 match.tag,
      description:         summary?.description || match.description,
      dataQuality:         summary ? 'live-products' : 'styles-only',
    });
  } catch (err) {
    console.error('getProductByStyleCode error:', err);
    return res.status(500).json({ message: err.message || 'Could not load product.' });
  }
};

// Alias: same as the Mongo-aware detail handler.
exports.getSSStyleDetail = exports.getProductByStyleCode;

// ─────────────────────────────────────────────────────────────────────────────
//  syncFromSS — kept for the day S&S unlocks /products/ for this account.
//  Tries the per-style fetch; throws on 404 (which is what happens today).
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSSProducts(styleName, styleID = null) {
  ensureSsCredentials();

  // Per S&S official docs (/V2/Products.aspx):
  //   - /products/{x}      expects a SKU identifier (Sku/SkuID/Gtin/YourSku).
  //   - /products/?styleid={N}  returns all SKU rows for a numeric styleID.
  //   - /products/?style={s}    accepts StyleID, PartNumber, or "Brand Name".
  // The styleid path is the most deterministic; use it whenever we have a
  // numeric ID. Otherwise resolve styleName -> styleID via findStyleByName
  // first (which already knows about Gildan's stripped-prefix naming).
  if (styleID != null) {
    const { data } = await ssClient.get('/products/', { params: { styleid: styleID } });
    if (Array.isArray(data) && data.length > 0) return data;
    throw new Error(`S&S returned no SKUs for styleID ${styleID}.`);
  }

  const target = String(styleName || '').trim();
  if (!target) throw new Error('styleName or styleID required');

  const match = await findStyleByName(target);
  if (!match) throw new Error(`No S&S style matches "${target}".`);
  const { data } = await ssClient.get('/products/', { params: { styleid: match.styleID } });
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`S&S returned no SKUs for ${match.style || match.styleName} (styleID ${match.styleID}).`);
  }
  return data;
}

function summarizeSsStyle(skus) {
  const first = skus[0];
  const colorMap = new Map();
  const sizeMap = new Map();
  let minPrice = Infinity;
  for (const sku of skus) {
    if (sku.sizeName && !sizeMap.has(sku.sizeName)) {
      sizeMap.set(sku.sizeName, {
        name:  sku.sizeName,
        code:  sku.sizeCode,
        order: sku.sizeOrder,
      });
    }
    if (typeof sku.piecePrice === 'number' && sku.piecePrice > 0) {
      minPrice = Math.min(minPrice, sku.piecePrice);
    }
    if (sku.colorName && !colorMap.has(sku.colorName)) {
      colorMap.set(sku.colorName, {
        name:        sku.colorName,
        hex:         sku.color1 || '#CCCCCC',
        front:       ssImageUrl(sku.colorFrontImage),
        back:        ssImageUrl(sku.colorBackImage),
        side:        ssImageUrl(sku.colorSideImage),
        swatch:      ssImageUrl(sku.colorSwatchImage),
        colorFamily: sku.colorFamily || null,
        colorGroup:  sku.colorGroup  || null,
        colorCode:   sku.colorCode   || null,
      });
    }
  }
  const sizes = [...sizeMap.values()].sort((a, b) =>
    String(a.order || '').localeCompare(String(b.order || ''))
  );
  const colors = [...colorMap.values()];
  return {
    styleName:       first.styleName,
    brand:           first.brandName,
    title:           first.title || first.styleTitle || `${first.brandName} ${first.styleName}`,
    description:     first.description || null,
    minPrice:        minPrice === Infinity ? null : minPrice,
    sizes,
    sizeRangeBottom: sizes[0]?.name || null,
    sizeRangeTop:    sizes[sizes.length - 1]?.name || null,
    colors,
    ssStyleID:       first.styleID,
  };
}

exports.syncFromSS = async (req, res) => {
  try {
    ensureSsCredentials();
    const { styles, tag } = req.body || {};
    if (!Array.isArray(styles) || styles.length === 0) return res.status(400).json({ message: 'Provide a non-empty `styles` array.' });

    let created = 0, updated = 0;
    const products = [], failed = [];
    for (const styleName of styles) {
      try {
        const skus = await fetchSSProducts(styleName);
        const summary = summarizeSsStyle(skus);
        const category = detectCategory(summary.title);
        const update = {
          name: summary.title, vendor: summary.brand || 'S&S Activewear',
          brandName: summary.brand, style: summary.styleName, ssStyleID: summary.ssStyleID,
          source: 'ssactivewear', basePrice: summary.minPrice,
          priceFrom: startingAt(summary.minPrice, category),
          description: summary.description || CATEGORY_DESCRIPTIONS[category] || `${summary.brand} ${summary.styleName}`,
          sizeRangeBottom: summary.sizeRangeBottom, sizeRangeTop: summary.sizeRangeTop,
          colors: summary.colors.map((c) => c.name),
          colorCodes: summary.colors.map((c) => (c.hex || '#CCCCCC').toUpperCase()),
          productFrontImages: summary.colors.map((c) => c.front || null),
          productBackImages:  summary.colors.map((c) => c.back  || null),
          rating: deriveRating(summary.styleName),
          tag: tag || deriveTag(summary.brand, summary.styleName),
          category, type: detectType(summary.title),
        };
        const existing = await Product.findOne({ style: summary.styleName });
        let saved;
        if (existing) { Object.assign(existing, update); saved = await existing.save(); updated++; }
        else { saved = await Product.create(update); created++; }
        products.push({ style: saved.style, name: saved.name });
      } catch (e) {
        failed.push({ style: styleName, reason: e.message });
      }
    }
    return res.status(200).json({ created, updated, products, failed });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.refreshAllSSProductsHandler = async (req, res) => {
  // /products/ doesn't work for our account; nothing to refresh per-SKU.
  // Just refresh the /styles/ caches.
  _ssCache.clear();
  try {
    const data = await fetchAllSSBrands();
    return res.status(200).json({ message: 'Catalog caches refreshed.', styleCount: data.total });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

// Backwards-compat batch endpoints used by the catalog. Now both read from
// the brand caches (no /products/ calls anywhere).
exports.getSSImages = async (req, res) => {
  try {
    const { styles } = req.query;
    if (!styles) return res.json({ images: {} });
    const styleList = String(styles).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const out = {};
    for (const s of styleList) {
      const m = await findStyleByName(s);
      if (m && m.image) out[s] = m.image;
    }
    return res.json({ images: out });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.getSSDetails = async (req, res) => {
  try {
    const { styles } = req.query;
    if (!styles) return res.json({ details: {} });
    const styleList = String(styles).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const out = {};
    for (const s of styleList) {
      const m = await findStyleByName(s);
      if (m) {
        out[s] = {
          style: s,
          priceFrom: m.priceFrom,
          sizeRangeBottom: m.sizeRangeBottom,
          sizeRangeTop: m.sizeRangeTop,
          colorCount: m.colorCount,
          image: m.image,
        };
      }
    }
    return res.json({ details: out });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// Comprehensive S&S diagnostic — tries every plausible /products/ and
// /styles/ shape for one style, plus a brand-filtered sample so we can
// see what fields S&S actually populates. Visit
//   /api/products/ss/debug?style=G500&brand=Gildan&styleid=9182
// in a browser and paste the JSON. The first attempt that returns
// rowCount > 0 and a styleName matching the query is the one we should
// wire into fetchSSProducts.
exports.debugSSStyle = async (req, res) => {
  try {
    ensureSsCredentials();
    const style   = String(req.query.style   || '').trim();
    const brand   = String(req.query.brand   || '').trim();
    const styleid = String(req.query.styleid || '').trim();
    if (!style && !styleid) {
      return res.status(400).json({
        message: 'Provide ?style=X (and optionally &brand=Y&styleid=N).',
      });
    }

    // List of paths to try. Each entry is [label, axios call factory].
    const attempts = [];
    const push = (label, fn) => attempts.push({ label, fn });

    // ── /v2/products/ variants ──────────────────────────────────────────────
    if (style) {
      push(`GET /products?style=${style}`,
        () => ssClient.get('/products', { params: { style } }));
      push(`GET /products?styleName=${style}`,
        () => ssClient.get('/products', { params: { styleName: style } }));
      push(`GET /products/?style=${style}`,
        () => ssClient.get('/products/', { params: { style } }));
      push(`GET /products/${style}`,
        () => ssClient.get(`/products/${encodeURIComponent(style)}`));
      if (brand) {
        push(`GET /products?brand=${brand}&style=${style}`,
          () => ssClient.get('/products', { params: { brand, style } }));
        push(`GET /products/?brand=${brand}&style=${style}`,
          () => ssClient.get('/products/', { params: { brand, style } }));
      }
    }
    if (styleid) {
      push(`GET /products?styleid=${styleid}`,
        () => ssClient.get('/products', { params: { styleid } }));
      push(`GET /products?styleID=${styleid}`,
        () => ssClient.get('/products', { params: { styleID: styleid } }));
      push(`GET /products/${styleid}`,
        () => ssClient.get(`/products/${styleid}`));
    }

    // ── /v2/inventory/ (sometimes mirrors products) ─────────────────────────
    if (style) {
      push(`GET /inventory?style=${style}`,
        () => ssClient.get('/inventory', { params: { style } }));
    }
    if (styleid) {
      push(`GET /inventory/${styleid}`,
        () => ssClient.get(`/inventory/${styleid}`));
    }

    // ── /v2/styles/ detail variants ─────────────────────────────────────────
    if (styleid) {
      push(`GET /styles/${styleid}`,
        () => ssClient.get(`/styles/${styleid}`));
    }
    if (style) {
      push(`GET /styles/${style}`,
        () => ssClient.get(`/styles/${encodeURIComponent(style)}`));
    }
    if (brand) {
      push(`GET /styles?brand=${brand} (one row sample)`,
        () => ssClient.get('/styles', { params: { brand } }));
    }

    // Run them sequentially so the JSON output is ordered + readable.
    const results = [];
    for (const a of attempts) {
      const t0 = Date.now();
      try {
        const resp = await a.fn();
        const data = resp.data;
        const ms = Date.now() - t0;
        const isArr = Array.isArray(data);
        const first = isArr ? data[0] : data;
        const matchesQueriedStyle = isArr && style
          ? data.some((row) => (row?.styleName || '').toLowerCase() === style.toLowerCase())
          : null;
        results.push({
          attempt: a.label,
          ms,
          status: resp.status,
          rowCount: isArr ? data.length : 'non-array',
          matchesQueriedStyle,
          firstRowKeys: first && typeof first === 'object' ? Object.keys(first).slice(0, 30) : null,
          firstRow: first && typeof first === 'object' ? {
            styleID:        first.styleID,
            styleName:      first.styleName,
            partNumber:     first.partNumber,
            brandName:      first.brandName,
            title:          first.title,
            sku:            first.sku,
            colorName:      first.colorName,
            sizeName:       first.sizeName,
            piecePrice:     first.piecePrice,
            colorFrontImage: first.colorFrontImage,
            colorCount:     first.colorCount,
            sizeRangeBottom: first.sizeRangeBottom,
            sizeRangeTop:    first.sizeRangeTop,
          } : null,
        });
      } catch (e) {
        results.push({
          attempt: a.label,
          ms: Date.now() - t0,
          status: e?.response?.status || null,
          error: e.message,
          body: e?.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : null,
        });
      }
    }

    return res.json({
      query: { style, brand, styleid },
      summary: results
        .filter((r) => r.rowCount > 0 && r.matchesQueriedStyle === true)
        .map((r) => r.attempt),
      attempts: results,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// S&S identity probe. Per the official docs:
//   - GET /v2/styles  returns ALL styles (no brand filter param exists)
//   - GET /v2/products/?style={id} accepts StyleID OR PartNumber OR "BrandName StyleName"
//   - styleName has NO brand prefix: Gildan's "G2000" is stored as styleName "2000"
//
// This endpoint resolves whatever the caller asks for to the real S&S record(s):
//   /api/products/ss/find?styleName=5000&brandName=Gildan
//   /api/products/ss/find?partnumber=00760
//   /api/products/ss/find?brandName=Gildan         (lists all Gildan styles)
exports.findSSStyle = async (req, res) => {
  try {
    ensureSsCredentials();
    const styleName  = String(req.query.styleName  || '').trim();
    const brandName  = String(req.query.brandName  || '').trim();
    const partnumber = String(req.query.partnumber || '').trim();
    if (!styleName && !brandName && !partnumber) {
      return res.status(400).json({
        message: 'Provide at least one of ?styleName=X, ?brandName=Y, ?partnumber=Z.',
      });
    }

    const t0 = Date.now();
    const stylesResp = await ssClient.get('/styles');
    const allStyles = Array.isArray(stylesResp.data) ? stylesResp.data : [];
    const stylesMs = Date.now() - t0;

    const norm = (v) => String(v || '').toLowerCase().trim();
    const exact = (a, b) => norm(a) === norm(b);

    // Tiered matching:
    //   1. exact styleName + brandName
    //   2. exact partNumber
    //   3. exact styleName alone
    //   4. all rows for brandName (browse mode)
    let matches = [];
    let matchMode = null;
    if (styleName && brandName) {
      matches = allStyles.filter((s) => exact(s.styleName, styleName) && exact(s.brandName, brandName));
      matchMode = 'styleName+brandName exact';
    }
    if (!matches.length && partnumber) {
      matches = allStyles.filter((s) => exact(s.partNumber, partnumber));
      matchMode = 'partNumber exact';
    }
    if (!matches.length && styleName) {
      matches = allStyles.filter((s) => exact(s.styleName, styleName));
      matchMode = 'styleName exact (any brand)';
    }

    // Browse mode: list all styles for the given brand if we didn't find a hit.
    let brandCatalog = null;
    if (!matches.length && brandName) {
      const brandStyles = allStyles
        .filter((s) => exact(s.brandName, brandName))
        .map((s) => ({
          styleID: s.styleID,
          partNumber: s.partNumber,
          brandName: s.brandName,
          styleName: s.styleName,
          title: s.title,
          baseCategory: s.baseCategory,
        }));
      brandCatalog = {
        brandName,
        count: brandStyles.length,
        styles: brandStyles,
      };
      matchMode = matchMode || 'brand-only browse';
    }

    // Near-miss suggestions if still nothing useful.
    let nearMisses = null;
    if (!matches.length && styleName && (!brandCatalog || brandCatalog.count === 0)) {
      const needle = styleName.toLowerCase();
      nearMisses = allStyles
        .filter((s) => norm(s.styleName).includes(needle) || norm(s.partNumber).includes(needle))
        .slice(0, 20)
        .map((s) => ({ styleID: s.styleID, styleName: s.styleName, brandName: s.brandName, partNumber: s.partNumber, title: s.title }));
    }

    // For real matches, enrich with the products call (color/size SKU rows).
    const enriched = [];
    for (const m of matches.slice(0, 3)) {
      const t1 = Date.now();
      try {
        const prodResp = await ssClient.get('/products/', { params: { styleid: m.styleID } });
        const skus = Array.isArray(prodResp.data) ? prodResp.data : [];
        const productsMs = Date.now() - t1;

        const colorMap = new Map();
        for (const s of skus) {
          if (!s.colorName || colorMap.has(s.colorName)) continue;
          colorMap.set(s.colorName, {
            colorName: s.colorName,
            colorCode: s.colorCode,
            colorGroup: s.colorGroup,
            colorFamily: s.colorFamily,
            colorSwatchImage: s.colorSwatchImage,
            colorFrontImage: s.colorFrontImage,
            color1: s.color1,
          });
        }
        const sizeMap = new Map();
        for (const s of skus) {
          if (!s.sizeName || sizeMap.has(s.sizeName)) continue;
          sizeMap.set(s.sizeName, { sizeName: s.sizeName, sizeCode: s.sizeCode, sizeOrder: s.sizeOrder });
        }
        const sizes = [...sizeMap.values()].sort((a, b) => String(a.sizeOrder).localeCompare(String(b.sizeOrder)));

        enriched.push({
          styleID: m.styleID,
          partNumber: m.partNumber,
          brandName: m.brandName,
          styleName: m.styleName,
          title: m.title,
          productsMs,
          skuCount: skus.length,
          uniqueColorCount: colorMap.size,
          uniqueSizeCount: sizeMap.size,
          colors: [...colorMap.values()],
          sizes,
        });
      } catch (e) {
        enriched.push({
          styleID: m.styleID, styleName: m.styleName, brandName: m.brandName,
          error: e.message, status: e?.response?.status,
        });
      }
    }

    return res.json({
      query: { styleName, brandName, partnumber },
      totalStylesScanned: allStyles.length,
      stylesMs,
      matchMode,
      matchedCount: matches.length,
      results: enriched,
      brandCatalog,
      nearMisses,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  One-time on-boot cleanup — runs idempotently each startup, dropping the
//  old GridFS image bucket and removing S&S products whose images are still
//  ObjectIds (from the abandoned sync attempt). Free Mongo M0 reclaims the
//  space and the catalog stays clean. Idempotent: collections-already-gone
//  and zero-products-to-delete are no-ops.
// ─────────────────────────────────────────────────────────────────────────────
async function runOneTimeCleanup() {
  try {
    const db = mongoose.connection.db;
    if (!db) return;

    // Drop the legacy GridFS bucket if it exists.
    const cols = await db.listCollections({}).toArray();
    const colNames = cols.map((c) => c.name);
    for (const name of ['images.files', 'images.chunks']) {
      if (colNames.includes(name)) {
        try {
          await db.collection(name).drop();
          console.log(`[cleanup] dropped ${name}`);
        } catch (_) {}
      }
    }

    // Remove S&S products whose first image entry is an ObjectId rather than
    // a URL string — those are stale from the abandoned sync.
    const result = await Product.deleteMany({
      source: 'ssactivewear',
      $or: [
        { 'productFrontImages.0': { $type: 'objectId' } },
        { 'productBackImages.0':  { $type: 'objectId' } },
      ],
    });
    if (result.deletedCount) {
      console.log(`[cleanup] removed ${result.deletedCount} stale S&S products with ObjectId images`);
    }
  } catch (e) {
    console.warn('[cleanup] non-fatal failure:', e.message);
  }
}

exports.runOneTimeCleanup = runOneTimeCleanup;

// Manual admin trigger kept so you can re-run from a button later if needed,
// but the work happens automatically at boot now.
exports.dropGridfsAndStaleSync = async (req, res) => {
  await runOneTimeCleanup();
  return res.status(200).json({ message: 'Cleanup complete.' });
};

// No-op warmAll — kept as a route handler so the old admin button doesn't
// 404, but /products/ doesn't work for us so there's nothing to warm
// beyond the /styles/ cache that warmSSCache already handles.
exports.warmAllStylesHandler = async (req, res) => {
  return res.status(200).json({
    message: 'Per-style warm is disabled (S&S /products/ is unavailable for this account). /styles/ caches are kept fresh automatically every 4 hours.',
  });
};
