// Printer rate cards — the pricing matrices the quoter looks up for accurate
// COGS (printer cost), plus admin CRUD to view/correct them.

const mongoose = require('mongoose');
const PrinterRateCard = require('../models/PrinterRateCard');
const { lookupPrice } = require('../services/pricingEngine');
const product = require('./product');

const badId = (id) => !mongoose.isValidObjectId(id);
const nameRegex = (name) =>
  new RegExp(`^${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

// GET /api/rate-cards — lightweight list for the printer picker.
const list = async (_req, res) => {
  try {
    const cards = await PrinterRateCard.find({}).sort({ printerName: 1 }).lean();
    const rateCards = cards.map((c) => ({
      _id: c._id,
      printerName: c.printerName,
      region: c.region,
      state: c.state,
      methods: [...new Set((c.groups || []).map((g) => g.method))],
      groupCount: (c.groups || []).length,
      updatedAt: c.updatedAt,
    }));
    res.json({ rateCards });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/rate-cards/by-name/:printerName — full card, so the quoter can build
// the right inputs (methods, garment-shade options, size tiers, etc.).
const getByName = async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.printerName || '');
    const card = await PrinterRateCard.findOne({ printerName: nameRegex(name) }).lean();
    if (!card) return res.status(404).json({ message: 'No rate card for this printer.' });
    res.json({ rateCard: card });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// PUT /api/rate-cards/:id — admin edits (numbers, fees, rules).
const update = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Rate card not found.' });
    const body = { ...req.body };
    delete body._id; delete body.createdAt; delete body.updatedAt;
    const card = await PrinterRateCard.findByIdAndUpdate(
      req.params.id, { $set: body }, { new: true, runValidators: true },
    ).lean();
    if (!card) return res.status(404).json({ message: 'Rate card not found.' });
    res.json({ rateCard: card });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// POST /api/rate-cards/lookup — body { printerName, method, quantity, numColors,
// numLocations, garmentShade, stitchCount, imprintSize, sides, product,
// selectedAddOns[] }. Returns the deterministic { unitPrintCost, setupCost,
// addOns, availableAddOns, flags, breakdown }.
const lookup = async (req, res) => {
  try {
    const printerName = (req.body && req.body.printerName) || '';
    if (!printerName) return res.status(400).json({ message: 'printerName is required.' });
    const card = await PrinterRateCard.findOne({ printerName: nameRegex(printerName) }).lean();
    if (!card) return res.status(404).json({ message: `No rate card on file for ${printerName}.` });
    res.json(lookupPrice(card, req.body));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/rate-cards/blank-price?style=SS4500&brand=Gildan — averaged S–2XL
// non-discounted blank cost, pulled live from the official S&S API.
const blankPrice = async (req, res) => {
  try {
    const r = await product.getBlankAverage(req.query.style, req.query.brand || null);
    res.json(r);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
};

module.exports = { list, getByName, update, lookup, blankPrice };
