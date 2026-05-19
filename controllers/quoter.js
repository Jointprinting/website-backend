const Quote   = require('../models/Quote');
const Product = require('../models/Product');

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
// Returns budget/mid/premium product suggestions + full list for that category
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

    res.json({ budget, mid, premium, all: products });
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
    res.json(product);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
