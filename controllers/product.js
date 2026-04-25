// controllers/product.js
require('dotenv').config();

const xml2js = require('xml2js');
const axios = require('axios');
const sharp = require('sharp');
const Product = require('../models/Product');
const { getGfs } = require('../gridfs');

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
//  Smart category/type detection from product name
// ─────────────────────────────────────────────────────────────────────────────
function detectCategory(name = '') {
  const n = name.toLowerCase();
  if (/(hoodie|hooded|pullover|zip[-\s]?up|fleece)/.test(n)) return 'Hoodies';
  if (/(pant|jogger|sweatpant|short[s]?|legging|trouser)/.test(n)) return 'Pants';
  if (/(cap|hat|beanie|trucker|snapback|bucket|visor)/.test(n)) return 'Hats';
  if (/(tee|shirt|tank|polo|jersey|long[-\s]?sleeve|crewneck|crew[-\s]?neck|sweater|sweatshirt)/.test(n)) return 'Shirts';
  return 'Shirts'; // safest default
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

    const { category, type } = req.query;
    const query = {};
    if (category) query.category = category;
    if (type)     query.type = type;

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
//  Existing Alpha Broder XML add (kept as fallback for manual entry)
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

  const product = new Product({
    name, vendor, style, description,
    sizeRangeBottom: sizeNames[0] || 'S',
    sizeRangeTop:    sizeNames[sizeNames.length - 1] || 'XL',
    colors: colorArray,
    colorCodes,
    productFrontImages,
    productBackImages,
    category: req.body.category,
    priceRangeBottom: req.body.priceRangeBottom,
    priceRangeTop: req.body.priceRangeTop,
    rating: req.body.rating,
    tag: req.body.tag,
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

    const markupNum = Number.isFinite(Number(markup)) && Number(markup) > 0 ? Number(markup) : 2.5;
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

        // Pricing: floor at $5, round to nearest $0.50
        let lo = (summary.minPrice || 8) * markupNum;
        let hi = lo * 1.4; // typical spread for printed-apparel orders
        const round50c = (n) => Math.max(5, Math.round(n * 2) / 2);
        const priceRangeBottom = round50c(lo);
        const priceRangeTop    = round50c(hi);

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
          rating: 5,
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
