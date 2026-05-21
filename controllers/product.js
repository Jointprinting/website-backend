// controllers/product.js
require('dotenv').config();

const xml2js = require('xml2js');
const axios = require('axios');
const mongoose = require('mongoose');
const sharp = require('sharp');
const Product = require('../models/Product');
const { getGfs } = require('../gridfs');

// ─────────────────────────────────────────────────────────────────────────────
//  Pricing — "Starting at $X" model
// ─────────────────────────────────────────────────────────────────────────────
//  One number per product, displayed as "Starting at $X". Computed from real
//  blank cost × small markup, with a per-category minimum floor so a brand-new
//  unsynced style still gets a sensible-looking number while we wait for the
//  background sync to populate the real basePrice. Printing cost is NOT baked
//  in — that's communicated to the customer separately when they request a
//  quote, matching FreshPrints-style displayed pricing.

const BLANK_MARKUP = 1.6; // basePrice × 1.6 = displayed "Starting at"

const CATEGORY_MIN_PRICE = {
  'T-Shirts':    7,
  'Long Sleeve': 9,
  'Tanks':       7,
  'Polos':       14,
  'Hoodies':     16,
  'Zip-Ups':     20,
  'Crewnecks':   14,
  'Jackets':     30,
  'Pants':       14,
  'Shorts':      11,
  'Hats':        8,
};

function startingAt(basePrice, category) {
  const floor = CATEGORY_MIN_PRICE[category] != null ? CATEGORY_MIN_PRICE[category] : 8;
  const computed = (typeof basePrice === 'number' && basePrice > 0)
    ? Math.round(basePrice * BLANK_MARKUP)
    : 0;
  return Math.max(floor, computed);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sensible size defaults — only used for the live fallback when we don't have
//  real SKU data yet. Once a style is synced, real sizes from /products/ win.
// ─────────────────────────────────────────────────────────────────────────────
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

// Used by the detail page when S&S returns an empty `description` for a style.
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
    throw new Error('S&S Activewear credentials are not configured. Set SS_ACCOUNT and SS_API_KEY env vars.');
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

function detectCategory(name = '') {
  const n = name.toLowerCase();
  if (/(full[-\s]?zip|zip[-\s]?up)/.test(n))                                  return 'Zip-Ups';
  if (/(hoodie|hooded)/.test(n))                                               return 'Hoodies';
  if (/(crewneck|crew[-\s]?neck|sweatshirt|fleece|sherpa)/.test(n))           return 'Crewnecks';
  if (/(tank|sleeveless|muscle)/.test(n))                                      return 'Tanks';
  if (/\bpolo\b/.test(n))                                                      return 'Polos';
  if (/(jacket|windbreaker|softshell|anorak|parka|vest|bomber|rain)/.test(n)) return 'Jackets';
  if (/(long[-\s]?sleeve|ls\b)/.test(n))                                      return 'Long Sleeve';
  if (/\bshort[s]?\b/.test(n))                                                 return 'Shorts';
  if (/(pant|jogger|sweatpant|legging|trouser)/.test(n))                      return 'Pants';
  if (/(cap|hat|beanie|trucker|snapback|bucket|visor)/.test(n))               return 'Hats';
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
//  Image helpers (legacy GridFS path + new pass-through-URL path)
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
  return new Promise((resolve) => {
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

// Resolve productFrontImages/productBackImages to display-ready URLs.
// New S&S records store CDN URLs as strings — pass through unchanged.
// Old AlphaBroder records store GridFS ObjectIds — base64-encode them.
async function populateImages(product) {
  const obj = product.toObject ? product.toObject() : product;
  const resolve = async (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    // ObjectId or { $oid: '...' } — legacy GridFS path
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
//  AlphaBroder XML add (legacy admin path — untouched except for pricing)
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

// ─────────────────────────────────────────────────────────────────────────────
//  S&S Activewear — per-style SKU fetch (styleID primary, styleName fallback)
// ─────────────────────────────────────────────────────────────────────────────
//  S&S's `/v2/products/` filter accepts SKU, partNumber, styleID, styleName,
//  or GTIN. The numeric styleID is the most reliable — we already get it from
//  `/v2/styles/`. styleName fallbacks handle catalog rows where styleID got
//  lost in transit.
async function fetchSSProducts(styleName, styleID = null) {
  ensureSsCredentials();
  const target = String(styleName || '').trim();
  if (!target && !styleID) throw new Error('styleName or styleID required');
  const targetLower = target.toLowerCase();

  const matchesTarget = (sku) => {
    if (styleID != null && sku?.styleID === styleID) return true;
    const sn = (sku?.styleName || '').trim().toLowerCase();
    const pn = (sku?.partNumber || '').trim().toLowerCase();
    return (target && sn === targetLower) || (target && pn === targetLower);
  };

  // Strategy 1: numeric styleID URL path (most authoritative)
  if (styleID != null) {
    try {
      const { data } = await ssClient.get(`/products/${styleID}`);
      if (Array.isArray(data) && data.length > 0) {
        const matched = data.filter(matchesTarget);
        if (matched.length > 0) return matched;
      }
    } catch (e) {
      console.warn(`[fetchSSProducts] /products/${styleID} (styleID) failed:`, e.message);
    }
  }

  // Strategy 2: styleName URL path
  if (target) {
    try {
      const { data } = await ssClient.get(`/products/${encodeURIComponent(target)}`);
      if (Array.isArray(data) && data.length > 0) {
        const matched = data.filter(matchesTarget);
        if (matched.length > 0) return matched;
      }
    } catch (e) {
      console.warn(`[fetchSSProducts] /products/${target} failed:`, e.message);
    }
  }

  // Strategy 3: query param
  if (target) {
    try {
      const { data } = await ssClient.get('/products/', { params: { style: target } });
      if (Array.isArray(data) && data.length > 0) {
        const matched = data.filter(matchesTarget);
        if (matched.length > 0) return matched;
      }
    } catch (e) {
      console.warn(`[fetchSSProducts] /products/?style=${target} failed:`, e.message);
    }
  }

  throw new Error(`No SKUs found for style "${target || styleID}".`);
}

function summarizeSsStyle(skus) {
  const first = skus[0];
  const styleName = first.styleName;
  const brand = first.brandName;
  const titleCandidate = first.title || first.styleTitle || first.styleDescription || `${brand} ${styleName}`;
  const descCandidate  = first.description || first.styleDescription || null;

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
        back:  ssImageUrl(sku.colorBackImage),
      });
    }
  }

  const orderedSizes = sortSizes(sizeSet);

  return {
    styleName, brand,
    title: titleCandidate,
    description: descCandidate,
    minPrice: minPrice === Infinity ? null : minPrice,
    sizeRangeBottom: orderedSizes[0] || null,
    sizeRangeTop:    orderedSizes[orderedSizes.length - 1] || null,
    colors: [...colorMap.values()],
    ssStyleID: first.styleID,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Single-style sync — stores S&S CDN URLs directly (NO GridFS uploads).
//  Memory + storage cost per style drops from ~50 MB image data to ~5 KB
//  of strings, so the full ~5,500-style warm fits comfortably in Mongo M0.
// ─────────────────────────────────────────────────────────────────────────────
const _inflightSyncs = new Map();

async function syncSingleStyle(styleName, opts = {}) {
  ensureSsCredentials();
  const skus    = await fetchSSProducts(styleName, opts.styleID || null);
  const summary = summarizeSsStyle(skus);
  const category = opts.overrideCategory || detectCategory(summary.title);
  const type     = opts.overrideType     || detectType(summary.title);
  const tag      = opts.tag || deriveTag(summary.brand, summary.styleName);

  // Plain string arrays — S&S CDN URLs. No download, no Sharp, no GridFS.
  const colors = [];
  const colorCodes = [];
  const productFrontImages = [];
  const productBackImages = [];
  for (const c of summary.colors) {
    colors.push(c.name);
    colorCodes.push((c.hex || '#CCCCCC').toUpperCase());
    productFrontImages.push(c.front || null);
    productBackImages.push(c.back || null);
  }

  const description = summary.description
    || CATEGORY_DESCRIPTIONS[category]
    || `${summary.brand} ${summary.styleName} — ${summary.title}`;

  const update = {
    name: summary.title,
    vendor: summary.brand || 'S&S Activewear',
    brandName: summary.brand,
    style: summary.styleName,
    ssStyleID: summary.ssStyleID,
    source: 'ssactivewear',
    basePrice: summary.minPrice,
    priceFrom: startingAt(summary.minPrice, category),
    description,
    sizeRangeBottom: summary.sizeRangeBottom,
    sizeRangeTop:    summary.sizeRangeTop,
    colors, colorCodes,
    productFrontImages, productBackImages,
    rating: deriveRating(summary.styleName),
    tag, category, type,
  };

  const existing = await Product.findOne({ style: summary.styleName });
  let saved;
  let created = false;
  if (existing) {
    // Preserve any admin-set priceFrom override on subsequent syncs.
    if (existing.priceFrom && existing.priceFrom !== startingAt(existing.basePrice, existing.category)) {
      delete update.priceFrom;
    }
    Object.assign(existing, update);
    saved = await existing.save();
  } else {
    saved = await Product.create(update);
    created = true;
  }
  return { saved, created };
}

function syncSingleStyleDeduped(styleName, opts = {}) {
  const key = String(styleName);
  if (_inflightSyncs.has(key)) return _inflightSyncs.get(key);
  const p = syncSingleStyle(styleName, opts).finally(() => _inflightSyncs.delete(key));
  _inflightSyncs.set(key, p);
  return p;
}

exports.syncSingleStyle = syncSingleStyle;
exports.syncSingleStyleDeduped = syncSingleStyleDeduped;

async function refreshAllSSProducts() {
  ensureSsCredentials();
  const ssProducts = await Product.find({ source: 'ssactivewear' }).select('style ssStyleID').lean();
  let updated = 0;
  const failed = [];

  for (const p of ssProducts) {
    try {
      const skus = await fetchSSProducts(p.style, p.ssStyleID || null);
      const summary = summarizeSsStyle(skus);
      const category = detectCategory(summary.title);
      await Product.updateOne(
        { style: p.style },
        { $set: {
            basePrice: summary.minPrice,
            priceFrom: startingAt(summary.minPrice, category),
            sizeRangeBottom: summary.sizeRangeBottom,
            sizeRangeTop:    summary.sizeRangeTop,
            updatedAt: new Date(),
          }
        }
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
    const { styles, tag, overrideCategory, overrideType } = req.body || {};
    if (!Array.isArray(styles) || styles.length === 0) return res.status(400).json({ message: 'Provide a non-empty `styles` array.' });
    if (styles.length > 50) return res.status(400).json({ message: 'Sync at most 50 styles per request.' });

    let created = 0, updated = 0;
    const products = [], failed = [];

    for (const styleName of styles) {
      try {
        const { saved, created: wasCreated } = await syncSingleStyle(styleName, { tag, overrideCategory, overrideType });
        if (wasCreated) created++; else updated++;
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
//  importFromJson (admin) — untouched apart from priceFrom mapping
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

// ─── S&S Live Browse ──────────────────────────────────────────────────────────
const _ssCache = new Map();
const SS_CACHE_TTL = 4 * 60 * 60 * 1000;

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
    throw new Error(`S&S catalog unavailable for brand "${brand}". (${detail})`);
  }
  if (data.length === 0) {
    throw new Error(`S&S returned no styles for brand "${brand}". Check SS_ACCOUNT / SS_API_KEY env vars.`);
  }

  const styles = [];
  for (const style of data) {
    const title = style.title || style.styleTitle || style.styleDescription
      || `${style.brandName || brand} ${style.styleName}`;
    const imageUrl = ssImageUrl(pickSSImagePath(style));
    const vendor   = style.brandName || brand;
    const category = detectCategory(title);
    const type     = detectType(title);
    const { sizeRangeBottom, sizeRangeTop } = defaultSizeRange(title, category, type);

    styles.push({
      style: style.styleName,
      styleID: style.styleID,                         // numeric, used for /products/ lookups
      name: title,
      vendor,
      category,
      type,
      priceFrom: startingAt(null, category),          // category min until sync writes real number
      sizeRangeBottom, sizeRangeTop,
      colorCount: style.colorCount || 0,
      rating: deriveRating(style.styleName),
      tag: deriveTag(vendor, title),
      image: imageUrl,
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

exports.warmSSCache = () => {
  if (!SS_ACCOUNT || !SS_API_KEY) return;
  console.log('[SS] Starting background /styles/ cache warm…');
  fetchAllSSBrands()
    .then((d) => console.log(`[SS] /styles/ cache warm done — ${d.total} styles.`))
    .catch((e) => console.warn('[SS] /styles/ cache warm failed:', e.message));
};

exports.warmAllStylesHandler = async (req, res) => {
  require('../services/ssWarmAll').warmAllStyles()
    .catch(e => console.error('[warmAll] background failure:', e.message));
  return res.status(202).json({ message: 'Warm-all started in background. Check Render logs for progress.' });
};

// Catalog endpoint: live /styles/ data + Mongo enrichment when synced.
// Synced styles get real priceFrom, sizes, color count, and first-color image
// (eliminating the gray-image -> color-image flicker users saw).
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

    const styleNames = pageSlice.map((s) => s.style);
    const synced = await Product.find({
      style: { $in: styleNames },
      source: 'ssactivewear',
    })
      .select('style priceFrom sizeRangeBottom sizeRangeTop colors productFrontImages ssStyleID')
      .lean();
    const bySN = new Map(synced.map((p) => [p.style, p]));

    const enriched = pageSlice.map((s) => {
      const m = bySN.get(s.style);
      if (!m) return s;
      const firstColorImg = (m.productFrontImages || []).find((v) => typeof v === 'string');
      return {
        ...s,
        priceFrom:       m.priceFrom        || s.priceFrom,
        sizeRangeBottom: m.sizeRangeBottom  || s.sizeRangeBottom,
        sizeRangeTop:    m.sizeRangeTop     || s.sizeRangeTop,
        colorCount:      (Array.isArray(m.colors) && m.colors.length) || s.colorCount,
        image:           firstColorImg      || s.image,  // kills gray->color flicker
        ssStyleID:       m.ssStyleID        || s.styleID,
      };
    });

    return res.json({ products: enriched, total, page: p, totalPages: Math.ceil(total / l) });
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
    const { data } = await ssClient.get('/styles/', { params: { brand: 'Gildan' }, timeout: 15_000 });
    if (!Array.isArray(data)) {
      return res.status(200).json({ ok: false, account, keySet, error: 'S&S returned non-array', sample: JSON.stringify(data).slice(0, 300) });
    }
    return res.status(200).json({
      ok: true, account, keySet,
      styleCount: data.length,
      sampleStyle: data[0]?.styleName || null,
      sampleStyleID: data[0]?.styleID || null,
      sampleFields: data[0] ? Object.keys(data[0]).slice(0, 15) : [],
    });
  } catch (err) {
    return res.status(200).json({ ok: false, account, keySet, error: err.message });
  }
};

// Diagnostic endpoint for debugging when /products/?style=X returns nothing.
// Visit /api/products/ss/debug?style=G500 in browser; paste the JSON back to
// me and I can see exactly what S&S returns for each strategy.
exports.debugSSStyle = async (req, res) => {
  try {
    ensureSsCredentials();
    const style = String(req.query.style || '').trim();
    if (!style) return res.status(400).json({ message: 'Provide ?style=X' });

    const report = { style, attempts: [] };

    // Attempt 1: /styles/?style=X
    try {
      const { data } = await ssClient.get('/styles/', { params: { style }, timeout: 10_000 });
      report.attempts.push({
        endpoint: '/styles/?style=' + style,
        rowCount: Array.isArray(data) ? data.length : 'non-array',
        firstRow: Array.isArray(data) && data[0] ? {
          styleID:    data[0].styleID,
          styleName:  data[0].styleName,
          partNumber: data[0].partNumber,
          brandName:  data[0].brandName,
          title:      data[0].title,
          fields:     Object.keys(data[0]).slice(0, 20),
        } : null,
      });

      const match = Array.isArray(data) ? data.find((r) => (r.styleName || '').toLowerCase() === style.toLowerCase()) || data[0] : null;
      const styleID = match?.styleID;

      // Attempt 2: /products/{styleID}
      if (styleID) {
        try {
          const r = await ssClient.get(`/products/${styleID}`, { timeout: 15_000 });
          report.attempts.push({
            endpoint: '/products/' + styleID + ' (styleID)',
            rowCount: Array.isArray(r.data) ? r.data.length : 'non-array',
            firstRow: Array.isArray(r.data) && r.data[0] ? {
              styleID:    r.data[0].styleID,
              styleName:  r.data[0].styleName,
              partNumber: r.data[0].partNumber,
              sku:        r.data[0].sku,
              colorName:  r.data[0].colorName,
              sizeName:   r.data[0].sizeName,
              piecePrice: r.data[0].piecePrice,
              colorFrontImage: r.data[0].colorFrontImage,
              fields:     Object.keys(r.data[0]).slice(0, 25),
            } : null,
          });
        } catch (e) {
          report.attempts.push({ endpoint: '/products/' + styleID, error: e.message });
        }
      }

      // Attempt 3: /products/{styleName}
      try {
        const r = await ssClient.get(`/products/${encodeURIComponent(style)}`, { timeout: 15_000 });
        report.attempts.push({
          endpoint: '/products/' + style + ' (styleName)',
          rowCount: Array.isArray(r.data) ? r.data.length : 'non-array',
          firstRow: Array.isArray(r.data) && r.data[0] ? {
            styleID:    r.data[0].styleID,
            styleName:  r.data[0].styleName,
            partNumber: r.data[0].partNumber,
          } : null,
        });
      } catch (e) {
        report.attempts.push({ endpoint: '/products/' + style, error: e.message });
      }

      // Attempt 4: /products/?style=X
      try {
        const r = await ssClient.get('/products/', { params: { style }, timeout: 15_000 });
        report.attempts.push({
          endpoint: '/products/?style=' + style,
          rowCount: Array.isArray(r.data) ? r.data.length : 'non-array',
          firstRow: Array.isArray(r.data) && r.data[0] ? {
            styleID:    r.data[0].styleID,
            styleName:  r.data[0].styleName,
            partNumber: r.data[0].partNumber,
          } : null,
        });
      } catch (e) {
        report.attempts.push({ endpoint: '/products/?style=' + style, error: e.message });
      }
    } catch (e) {
      report.attempts.push({ endpoint: '/styles/?style=' + style, error: e.message });
    }

    return res.json(report);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// One-time cleanup: drop the GridFS images bucket and remove any S&S products
// whose image arrays are still ObjectId-based (from the failed pre-warm
// attempts). Admin-only. Free Mongo M0 reclaims the space afterwards.
exports.dropGridfsAndStaleSync = async (req, res) => {
  try {
    let droppedFiles = 0;
    let droppedChunks = 0;
    let deletedProducts = 0;

    try {
      const db = mongoose.connection.db;
      const filesCount = await db.collection('images.files').countDocuments();
      const chunksCount = await db.collection('images.chunks').countDocuments();
      await db.collection('images.files').drop().catch(() => {});
      await db.collection('images.chunks').drop().catch(() => {});
      droppedFiles = filesCount;
      droppedChunks = chunksCount;
    } catch (e) {
      console.warn('[dropGridfs] bucket drop failed (may already be empty):', e.message);
    }

    // Re-sync any product whose images aren't all strings now.
    const stale = await Product.find({ source: 'ssactivewear' }).select('style productFrontImages').lean();
    const toDelete = stale.filter((p) =>
      (p.productFrontImages || []).some((v) => v != null && typeof v !== 'string')
    );
    if (toDelete.length) {
      const result = await Product.deleteMany({ _id: { $in: toDelete.map((p) => p._id) } });
      deletedProducts = result.deletedCount || 0;
    }

    return res.status(200).json({ droppedFiles, droppedChunks, deletedProducts });
  } catch (err) {
    console.error('dropGridfsAndStaleSync error:', err);
    return res.status(500).json({ message: err.message });
  }
};

// Detail page handler: Mongo first → on-demand sync if missing → honest live
// fallback (real /styles/ info, no faked colors/prices).
exports.getProductByStyleCode = async (req, res) => {
  try {
    const styleName = req.params.style;

    const existing = await Product.findOne({ style: styleName });
    if (existing) {
      return res.status(200).json(await populateImages(existing));
    }

    // Look up styleID from /styles/ so the sync's /products/ call has the
    // most reliable identifier available.
    let styleID = null;
    try {
      const { data } = await ssClient.get('/styles/', { params: { style: styleName }, timeout: 10_000 });
      const match = Array.isArray(data)
        ? data.find((s) => (s.styleName || '').toLowerCase() === styleName.toLowerCase()) || data[0]
        : null;
      styleID = match?.styleID || null;
    } catch (_) {}

    try {
      const { saved } = await syncSingleStyleDeduped(styleName, { styleID });
      if (saved) {
        return res.status(200).json(await populateImages(saved));
      }
    } catch (e) {
      console.warn(`[getProductByStyleCode] sync failed for "${styleName}":`, e.message);
    }

    return exports.getSSStyleDetail(req, res);
  } catch (err) {
    console.error('getProductByStyleCode error:', err);
    return res.status(500).json({ message: err.message || 'Could not load product.' });
  }
};

// Honest live fallback. Returns title/brand/image/description from /styles/.
// NO fake colors. priceFrom comes from category minimum.
exports.getSSStyleDetail = async (req, res) => {
  try {
    ensureSsCredentials();
    const styleName = req.params.style;

    const { data: stylesData } = await ssClient.get('/styles/', { params: { style: styleName }, timeout: 10_000 });
    const match = Array.isArray(stylesData)
      ? (stylesData.find((s) => (s.styleName || '').trim().toLowerCase() === styleName.trim().toLowerCase()) || stylesData[0])
      : null;

    if (!match) return res.status(404).json({ message: `Could not find style "${styleName}".` });

    const title = match.title || match.styleTitle || match.styleDescription || `${match.brandName || ''} ${match.styleName || styleName}`.trim();
    const brand = match.brandName || 'S&S Activewear';
    const category = detectCategory(title);
    const type = detectType(title);
    const { sizeRangeBottom, sizeRangeTop } = defaultSizeRange(title, category, type);
    const description = match.description || CATEGORY_DESCRIPTIONS[category] || `${brand} ${styleName}`;
    const imageUrl = ssImageUrl(pickSSImagePath(match));

    return res.json({
      style: match.styleName || styleName,
      ssStyleID: match.styleID,
      name: title,
      vendor: brand,
      category,
      type,
      priceFrom: startingAt(null, category),
      sizeRangeBottom,
      sizeRangeTop,
      colorCount: match.colorCount || 0,
      colors: [],
      colorCodes: [],
      productFrontImages: imageUrl ? [imageUrl] : [],
      productBackImages: [],
      rating: deriveRating(styleName),
      tag: deriveTag(brand, title),
      description,
      // Honest signal so the frontend can show "request a quote" instead of
      // pretending we have full data.
      dataQuality: 'fallback',
    });
  } catch (err) {
    console.error('getSSStyleDetail error:', err.message);
    return res.status(500).json({ message: err.message || 'Could not fetch style detail.' });
  }
};

// Kept for backward-compat with frontend's lazy /ss/details fetch. Now reads
// from Mongo only (no live S&S retry — that's what /ss/style/:style handles).
exports.getSSDetails = async (req, res) => {
  try {
    const { styles } = req.query;
    if (!styles) return res.json({ details: {} });
    const styleList = String(styles).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const synced = await Product.find({ style: { $in: styleList }, source: 'ssactivewear' })
      .select('style priceFrom sizeRangeBottom sizeRangeTop colors productFrontImages')
      .lean();
    const details = {};
    for (const m of synced) {
      const firstColorImg = (m.productFrontImages || []).find((v) => typeof v === 'string');
      details[m.style] = {
        style: m.style,
        priceFrom: m.priceFrom,
        sizeRangeBottom: m.sizeRangeBottom,
        sizeRangeTop: m.sizeRangeTop,
        colorCount: Array.isArray(m.colors) ? m.colors.length : 0,
        image: firstColorImg || null,
      };
    }
    return res.json({ details });
  } catch (err) {
    console.error('getSSDetails error:', err.message);
    return res.status(500).json({ message: err.message });
  }
};

// Image lookup kept for any old frontend calls to /ss/images. Just returns
// Mongo's first-color URL for each synced style; missing-style returns null.
exports.getSSImages = async (req, res) => {
  try {
    const { styles } = req.query;
    if (!styles) return res.json({ images: {} });
    const styleList = String(styles).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const synced = await Product.find({ style: { $in: styleList }, source: 'ssactivewear' })
      .select('style productFrontImages')
      .lean();
    const images = {};
    for (const m of synced) {
      const first = (m.productFrontImages || []).find((v) => typeof v === 'string');
      if (first) images[m.style] = first;
    }
    return res.json({ images });
  } catch (err) {
    console.error('getSSImages error:', err.message);
    return res.status(500).json({ message: err.message });
  }
};
