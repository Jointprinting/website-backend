const axios   = require('axios');
const { Client: NotionClient } = require('@notionhq/client');
const Quote   = require('../models/Quote');
const Product = require('../models/Product');

// Notion DB IDs (from the connected workspace)
const NOTION_ORDERS_DB = '417a4357-a804-4af7-be4d-b44059f8dea0';
const NOTION_CRM_DB    = '1fe560df-aaa4-8067-b042-c8f7b0e1fa24';

function getNotionClient() {
  const key = process.env.NOTION_API_KEY;
  if (!key) return null;
  return new NotionClient({ auth: key });
}

const GARMENT_CATEGORY = {
  'T-Shirt':            'Shirts',
  'Long Sleeve Shirt':  'Shirts',
  'Polo':               'Shirts',
  'Hoodie':             'Hoodies',
  'Crewneck':           'Hoodies',
  'Zip-Up Hoodie':      'Hoodies',
  'Quarter-Zip':        'Hoodies',
  'Sweatpant':          'Pants',
  'Hat':                'Hats',
  'Beanie':             'Hats',
  'Tote Bag':           'Promo',
  'Other':              'Promo',
};

// ── S&S live price helpers ────────────────────────────────────────────────────

function getSsClient() {
  const account = process.env.SS_ACCOUNT;
  const apiKey  = process.env.SS_API_KEY;
  if (!account || !apiKey) return null;
  return axios.create({
    baseURL: process.env.SS_API_BASE || 'https://api.ssactivewear.com/V2',
    auth: { username: account, password: apiKey },
    timeout: 12000,
  });
}

// Average piece price for sizes S–3XL, skipping 4XL and above.
// Returns null when the S&S API is unavailable or returns no data.
async function fetchAvgPrice(styleCode) {
  const client = getSsClient();
  if (!client || !styleCode) return null;
  try {
    const { data: skus } = await client.get('/Products.aspx', {
      params: { style: styleCode, mediatype: 'json' },
    });
    if (!Array.isArray(skus) || skus.length === 0) return null;

    const SKIP = /^(4XL|5XL|6XL|7XL|OSFA|OS$|One\s*Size)/i;
    const seenSizes = new Map();
    for (const sku of skus) {
      const size = (sku.sizeName || '').trim();
      if (!size || SKIP.test(size)) continue;
      if (!seenSizes.has(size) && typeof sku.piecePrice === 'number' && sku.piecePrice > 0) {
        seenSizes.set(size, sku.piecePrice);
      }
    }
    if (seenSizes.size === 0) return null;
    const prices = [...seenSizes.values()];
    return +( prices.reduce((a, b) => a + b, 0) / prices.length ).toFixed(4);
  } catch {
    return null;
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

// GET /api/quoter/quotes
exports.listQuotes = async (req, res) => {
  try {
    const { search } = req.query;
    const q = {};
    if (search) {
      const re = new RegExp(search.trim(), 'i');
      q.$or = [{ clientName: re }, { companyName: re }];
    }
    const quotes = await Quote.find(q)
      .select('clientName companyName printerName date status notes createdAt updatedAt garmentGroups')
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();
    res.json(quotes);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/quoter/quotes/:id
exports.getQuote = async (req, res) => {
  try {
    const quote = await Quote.findById(req.params.id).lean();
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    res.json(quote);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/quoter/quotes
exports.createQuote = async (req, res) => {
  try {
    const quote = new Quote(req.body);
    await quote.save();
    res.status(201).json(quote);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

// PUT /api/quoter/quotes/:id
exports.updateQuote = async (req, res) => {
  try {
    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    const { _id, createdAt, __v, ...updates } = req.body;
    Object.assign(quote, updates);
    await quote.save();
    res.json(quote);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

// DELETE /api/quoter/quotes/:id
exports.deleteQuote = async (req, res) => {
  try {
    await Quote.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/quoter/clients  — unique client/company names for autocomplete
exports.getClients = async (req, res) => {
  try {
    const [clients, companies] = await Promise.all([
      Quote.distinct('clientName'),
      Quote.distinct('companyName'),
    ]);
    res.json({
      clients:   clients.filter(Boolean).sort(),
      companies: companies.filter(Boolean).sort(),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/quoter/suggest?garmentType=Hoodie
// Returns budget/mid/premium suggestions with live S&S avgPrice (avg S–3XL).
exports.suggestTiers = async (req, res) => {
  try {
    const { garmentType } = req.query;
    const category = GARMENT_CATEGORY[garmentType] || 'Shirts';

    const products = await Product.find({ category, basePrice: { $gt: 0 } })
      .select('style brandName name basePrice category')
      .sort({ basePrice: 1 })
      .lean();

    if (!products.length) {
      return res.json({ budget: null, mid: null, premium: null, all: [] });
    }

    const budget  = products[0];
    const premium = products[products.length - 1];
    const mid     = products[Math.floor(products.length / 2)];

    // Live-fetch avg prices (3 concurrent S&S calls — takes ~500ms but always fresh)
    const [budgetAvg, midAvg, premiumAvg] = await Promise.all([
      fetchAvgPrice(budget.style),
      fetchAvgPrice(mid.style),
      fetchAvgPrice(premium.style),
    ]);

    const enrich = (p, avg) => ({ ...p, avgPrice: avg ?? p.basePrice });

    res.json({
      budget:  enrich(budget,  budgetAvg),
      mid:     enrich(mid,     midAvg),
      premium: enrich(premium, premiumAvg),
      all: products,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/quoter/style/:styleCode  — blank price + info for a style
exports.lookupStyle = async (req, res) => {
  try {
    const product = await Product.findOne({ style: req.params.styleCode })
      .select('style brandName name basePrice category')
      .lean();
    if (!product) return res.status(404).json({ message: 'Style not found in product database' });

    const avgPrice = await fetchAvgPrice(product.style);
    res.json({ ...product, avgPrice: avgPrice ?? product.basePrice });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/quoter/notion-order
// Creates a row in the Notion Orders database from a finalized quote.
// Requires NOTION_API_KEY env var. Returns { notionUrl } on success.
exports.createNotionOrder = async (req, res) => {
  const notion = getNotionClient();
  if (!notion) {
    return res.status(503).json({ message: 'NOTION_API_KEY not configured on server.' });
  }

  try {
    const {
      orderNumber, clientName, companyName, printer,
      items, cogs, clientInvoiced, mockupNumber, notes,
    } = req.body;

    // Try to find a matching CRM page by company name
    let crmPageUrl = null;
    try {
      const search = await notion.databases.query({
        database_id: NOTION_CRM_DB,
        filter: {
          property: 'Company Name',
          title: { contains: companyName || clientName || '' },
        },
        page_size: 1,
      });
      if (search.results.length > 0) {
        crmPageUrl = search.results[0].url;
      }
    } catch {
      // CRM lookup is best-effort
    }

    const properties = {
      'Order #':        { title:  [{ text: { content: orderNumber || '' } }] },
      'Printer':        { rich_text: [{ text: { content: printer || '' } }] },
      'Items':          { rich_text: [{ text: { content: items || '' } }] },
      'Mockup #':       { rich_text: [{ text: { content: mockupNumber || '' } }] },
      'Notes':          { rich_text: [{ text: { content: notes || '' } }] },
      'date:Date of Sale:start': { date: { start: new Date().toISOString().slice(0, 10) } },
      'Payment Status': { select: { name: 'Unpaid' } },
      'Shipment Status':{ select: { name: 'Not Started' } },
    };

    if (typeof cogs === 'number')          properties['COGS']            = { number: cogs };
    if (typeof clientInvoiced === 'number') properties['Client Invoiced'] = { number: clientInvoiced };

    if (crmPageUrl) {
      properties['Client'] = { relation: [{ url: crmPageUrl }] };
    }

    const page = await notion.pages.create({
      parent: { database_id: NOTION_ORDERS_DB },
      properties,
    });

    res.json({ notionUrl: page.url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
