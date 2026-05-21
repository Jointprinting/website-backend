const Order = require('../models/Order');
const ContactSubmission = require('../models/ContactSubmission');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const { deriveCompanyKey } = require('../models/Order');

// ─── Historical seed data ─────────────────────────────────────────────────────

const CLIENT_COMPANIES = {
  'Ryan Jotkoff':               'Jotkoff Financial Services',
  'Mike Woods':                 'Electric Starship Arcade',
  'Rita Tsalyuk':               'Stadium Gardens',
  'Alex Gelman':                '',
  'Nicole Romero':              "Earl and Tom's",
  'Jocelyn Melo':               'Cannapi',
  'Daequan Langhorn':           'OS NYC',
  'Elizabeth Brockmann':        'Point in Time Studios',
  'Jill Cohen':                 'The Cannaboss Lady',
  'Keegan Lapointe':            "Shaggy's Baggy",
  'Thomas Calmese':             'Green Gold',
  'Jason Grandizio':            'Sauce Me A Fry',
  'Shawn Hill / Amber Theurer': 'Human AF',
  "Ma'or Hemo":                 '',
  'Logan Davis':                '',
  'Maji':                       'M4JI',
  'Dredo':                      'Lean Gang Merch',
};

function _parseMockupNumbers(raw) {
  if (!raw || ['N/A (Tekweld)', 'N/A (Cannabis Promotions)', 'N/A (RedTupid)', 'N/A', ''].includes(raw)) return [];
  const parts = raw.replace(/\s/g, '').split(/[+,]/);
  const m = parts[0].match(/^(\d+)([A-Za-z]*)$/);
  if (!m) return [];
  const base = m[1].padStart(6, '0');
  const letters = [m[2], ...parts.slice(1)].filter(Boolean);
  return letters.map(l => `#${base}${l}`);
}

function _parseDate(str) {
  if (!str || str === 'N/A' || str === '') return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function _statusFromPaid(paidStr, invoiceNum) {
  const s = (paidStr || '').toLowerCase();
  if (s === 'paid') return 'delivered';
  if (s === 'voided') return 'cancelled';
  if (s === 'unpaid') return 'approved';
  if (!paidStr) return invoiceNum === '0000114' ? 'in_production' : 'placed';
  return 'placed';
}

const HISTORICAL_ORDERS = [
  { invoiceNum: '1001',    clientName: 'Ryan Jotkoff',              items: '50 polos, pocket embroidery',                         mockup: '000001B',           dateOfSale: '6/5/2024',   cogs: 844.21,  invoiced: 1682.86, paid: 'Paid',   printer: 'Apollo East' },
  { invoiceNum: '1002',    clientName: 'Mike Woods',                items: '100 shirts, chest screen print',                      mockup: '000005A+B',         dateOfSale: '7/4/2024',   cogs: 776.58,  invoiced: 1338.87, paid: 'Paid',   printer: 'Apollo East' },
  { invoiceNum: '1003',    clientName: 'Ryan Jotkoff',              items: "24 women's polos, pocket embroidery",                 mockup: '000010A',           dateOfSale: '9/12/2024',  cogs: 248.88,  invoiced: 416.49,  paid: 'Paid',   printer: 'Apollo East' },
  { invoiceNum: '1004',    clientName: 'Rita Tsalyuk',              items: '30,000 paper bags',                                   mockup: '000019C',           dateOfSale: '10/31/2024', cogs: 3984.94, invoiced: 4545.00, paid: 'Paid',   printer: '' },
  { invoiceNum: '1005',    clientName: 'Alex Gelman',               items: '500 toothbrushes',                                    mockup: '',                  dateOfSale: '11/20/2024', cogs: 443.24,  invoiced: 841.69,  paid: 'Paid',   printer: 'Tekweld' },
  { invoiceNum: '1009',    clientName: 'Nicole Romero',             items: '250 glass pipes (chillums)',                          mockup: '',                  dateOfSale: '',           cogs: 362.93,  invoiced: 551.00,  paid: 'Voided', printer: 'Cannabis Promotions' },
  { invoiceNum: '1012',    clientName: 'Jocelyn Melo',              items: '50 beanies embroidery + 50 hoodies screen print',     mockup: '000024F+D+E+H+I',   dateOfSale: '12/13/2024', cogs: 1454.79, invoiced: 1906.34, paid: 'Paid',   printer: 'Apollo East' },
  { invoiceNum: '1014',    clientName: 'Daequan Langhorn',          items: '54 hoodies + long sleeves, screen print',             mockup: '000023A+B',         dateOfSale: '1/19/2025',  cogs: 942.78,  invoiced: 1117.14, paid: 'Paid',   printer: 'Apollo East' },
  { invoiceNum: '1015',    clientName: 'Elizabeth Brockmann',       items: '20 shirts + 20 hats, screen print',                   mockup: '000029D+E',         dateOfSale: '2/20/2025',  cogs: 716.58,  invoiced: 1065.53, paid: 'Paid',   printer: 'Ace Screen Printing' },
  { invoiceNum: '1016',    clientName: 'Jill Cohen',                items: '300 lighters + 2 buttermint cases',                   mockup: '',                  dateOfSale: '2/24/2025',  cogs: 820.56,  invoiced: 907.05,  paid: 'Paid',   printer: 'Cannabis Promotions' },
  { invoiceNum: '1018',    clientName: 'Keegan Lapointe',           items: '300 lighters',                                        mockup: '',                  dateOfSale: '3/11/2025',  cogs: 564.91,  invoiced: 689.00,  paid: 'Paid',   printer: 'Cannabis Promotions' },
  { invoiceNum: '1020',    clientName: 'Keegan Lapointe',           items: '30 hoodies',                                          mockup: '000021H',           dateOfSale: '3/27/2025',  cogs: 846.58,  invoiced: 918.57,  paid: 'Paid',   printer: 'Ace Screen Printing' },
  { invoiceNum: '1019',    clientName: 'Nicole Romero',             items: '250 glass pipes (chillums)',                          mockup: '',                  dateOfSale: '3/27/2025',  cogs: 347.93,  invoiced: 545.85,  paid: 'Paid',   printer: 'Cannabis Promotions' },
  { invoiceNum: '1021',    clientName: 'Thomas Calmese',            items: '1,100 T-shirts',                                      mockup: '000033L',           dateOfSale: '3/28/2025',  cogs: 7714.24, invoiced: 8321.39, paid: 'Paid',   printer: 'Ace Screen Printing' },
  { invoiceNum: '1022',    clientName: 'Jason Grandizio',           items: '100 T-shirts',                                        mockup: '000040E+F',         dateOfSale: '5/14/2025',  cogs: 1191.48, invoiced: 1875.26, paid: 'Paid',   printer: 'Heritage Screen Printing' },
  { invoiceNum: '1023',    clientName: 'Jill Cohen',                items: '200 T-shirts, 250 lip balm',                          mockup: '000041C,K,M,G',     dateOfSale: '5/30/2025',  cogs: 2466.04, invoiced: 3318.34, paid: 'Paid',   printer: 'Contract-DTG' },
  { invoiceNum: '1025',    clientName: 'Jill Cohen',                items: '250 totes, 600 Bic lighters',                         mockup: '000043A,B',         dateOfSale: '6/30/2025',  cogs: 2194.98, invoiced: 2756.30, paid: 'Paid',   printer: 'Heritage Screen Printing' },
  { invoiceNum: '1023B',   clientName: 'Jill Cohen',                items: '200 T-shirts, 250 lip balm (add-on)',                 mockup: '000041C,K,M,G',     dateOfSale: '7/2/2025',   cogs: 107.55,  invoiced: 143.51,  paid: 'Paid',   printer: 'Contract-DTG' },
  { invoiceNum: '1027',    clientName: 'Daequan Langhorn',          items: '25 jerseys + 25 T-shirts',                            mockup: '000049A,B',         dateOfSale: '7/9/2025',   cogs: 698.93,  invoiced: 913.01,  paid: 'Paid',   printer: 'Heritage Screen Printing' },
  { invoiceNum: '1030',    clientName: 'Shawn Hill / Amber Theurer', items: '1 hoodie + 1 hat',                                   mockup: '000055B,D',         dateOfSale: '9/17/2025',  cogs: 0,       invoiced: 218.53,  paid: 'Paid',   printer: 'Heritage Screen Printing' },
  { invoiceNum: '1029',    clientName: 'Rita Tsalyuk',              items: '40,000 paper bags',                                   mockup: '000056A',           dateOfSale: '9/17/2025',  cogs: 4758.14, invoiced: 5600.00, paid: 'Paid',   printer: '' },
  { invoiceNum: '1031',    clientName: 'Alex Gelman',               items: '500 toothbrushes',                                    mockup: '',                  dateOfSale: '10/1/2025',  cogs: 374.00,  invoiced: 642.41,  paid: 'Paid',   printer: 'Tekweld' },
  { invoiceNum: '1032',    clientName: "Ma'or Hemo",                items: '20 linen kippahs',                                    mockup: '',                  dateOfSale: '11/3/2025',  cogs: 142.21,  invoiced: 180.65,  paid: 'Paid',   printer: 'RedTupid' },
  { invoiceNum: '1034',    clientName: 'Logan Davis',               items: 'Brand consulting',                                    mockup: '',                  dateOfSale: '12/3/2025',  cogs: 0,       invoiced: 4289.70, paid: 'Paid',   printer: '' },
  { invoiceNum: '1035',    clientName: 'Logan Davis',               items: 'Brand consulting',                                    mockup: '',                  dateOfSale: '',           cogs: 0,       invoiced: 2101.00, paid: 'Unpaid', printer: '' },
  { invoiceNum: '1036',    clientName: 'Jill Cohen',                items: '200 hoodies',                                         mockup: '000062A,B,C,D,E,F,G,H', dateOfSale: '12/6/2025', cogs: 3262.08, invoiced: 4852.89, paid: '', printer: 'Contract-DTG' },
  { invoiceNum: 'UNK-111', clientName: 'Maji',                      items: '25 hoodies + 25 T-shirts',                            mockup: '000060A+B',         dateOfSale: '',           cogs: 0,       invoiced: 1070.58, paid: '', printer: '' },
  // Lean Gang / Dredo — historical
  { invoiceNum: 'LG-2025-1', clientName: 'Dredo', items: '25 CC C1717 shirts (Graphite, DTG), 25 CC C1717 shirts (Grape, DTG), 15 BC 3727 sweatpants (DTG), 15 TT11SH shorts (DTF), 25 snapback hats (embroidery), 25 beanies (embroidery)', mockup: '000028D,E,F,G,H,I', dateOfSale: '2/25/2025', cogs: 0, invoiced: 3099.43, paid: 'Paid', printer: 'Cole Apparel' },
  { invoiceNum: 'LG-2025-2', clientName: 'Dredo', items: '15 BC 3727 sweatpants (DTG), 15 TT11SH shorts (DTF)', mockup: '000028H,I', dateOfSale: '2/26/2025', cogs: 0, invoiced: 724.58, paid: 'Paid', printer: 'Cole Apparel' },
  // Lean Gang / Dredo — new order May 2026
  { invoiceNum: 'LG-2026-1', clientName: 'Dredo', items: '25 Paragon 500 polos (Screen Printing, Turquoise), 25 Bella Canvas 3001 tees (Screen Printing, Clay), 25 SS3000 crewnecks (Screen Printing)', mockup: '', dateOfSale: '5/20/2026', cogs: 0, invoiced: 1651.19, paid: 'Unpaid', printer: '' },
];

// POST /api/orders/seed-historical
//   - creates orders that don't exist yet
//   - backfills empty mockupNumbers / printerName on orders that do exist
//     (so users who seeded before mockup parsing existed pick up the data)
const seedHistorical = async (req, res) => {
  try {
    let created = 0, skipped = 0, backfilled = 0;
    for (const raw of HISTORICAL_ORDERS) {
      const companyName = CLIENT_COMPANIES[raw.clientName] ?? '';
      const mockupNumbers = _parseMockupNumbers(raw.mockup);
      const existing = await Order.findOne({ orderNumber: raw.invoiceNum });

      if (existing) {
        const patch = {};
        if ((!existing.mockupNumbers || existing.mockupNumbers.length === 0)
            && mockupNumbers.length > 0) {
          patch.mockupNumbers = mockupNumbers;
        }
        if (!existing.printerName && raw.printer) {
          patch.printerName = raw.printer;
        }
        if (Object.keys(patch).length > 0) {
          await Order.updateOne({ _id: existing._id }, { $set: patch });
          backfilled++;
        } else {
          skipped++;
        }
        continue;
      }

      const status = _statusFromPaid(raw.paid, raw.invoiceNum);
      await Order.create({
        orderNumber:  raw.invoiceNum,
        clientName:   raw.clientName,
        companyName,
        status,
        totalValue:   raw.invoiced,
        cogs:         raw.cogs,
        printerName:  raw.printer || '',
        mockupNumbers,
        items: [{ description: raw.items, qty: 0, unitPrice: 0 }],
        orderDate:    _parseDate(raw.dateOfSale),
        importedFrom: 'order_tracker',
      });
      created++;
    }
    res.json({ created, backfilled, skipped, total: HISTORICAL_ORDERS.length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders?search=&status=&page=&limit=
const listOrders = async (req, res) => {
  try {
    const { search = '', status, page = 1, limit = 100 } = req.query;
    const filter = {};
    if (search.trim()) {
      const re = new RegExp(search.trim(), 'i');
      filter.$or = [{ clientName: re }, { companyName: re }, { orderNumber: re }];
    }
    if (status) filter.status = status;
    const orders = await Order.find(filter)
      .sort({ orderDate: -1, createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();
    const total = await Order.countDocuments(filter);
    res.json({ orders, total });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/clients — distinct companies with stats + tier (lead | client)
// Cancelled excluded from counts/revenue. Tier = 'client' if any order is placed+, else 'lead'.
const CLIENT_TIER_STATUSES = ['placed', 'in_production', 'shipped', 'delivered'];
const listClients = async (req, res) => {
  try {
    const pipeline = [
      { $group: {
        _id: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ['$companyKey', ''] } }, 0] },
            '$companyKey',
            { $toLower: { $ifNull: ['$companyName', '$clientName'] } },
          ],
        },
        companyName:    { $first: '$companyName' },
        clientName:     { $first: '$clientName' },
        orderCount:     { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, 1, 0] } },
        allOrderCount:  { $sum: 1 },
        totalRevenue:   { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$totalValue', 0] } },
        lastOrderDate:  { $max: '$orderDate' },
        lastActivity:   { $max: '$createdAt' },
        statuses:       { $addToSet: '$status' },
      }},
      { $addFields: {
        tier: {
          $cond: [
            { $gt: [{ $size: { $setIntersection: ['$statuses', CLIENT_TIER_STATUSES] } }, 0] },
            'client',
            'lead',
          ],
        },
      }},
      { $sort: { lastActivity: -1 } },
    ];
    const clients = await Order.aggregate(pipeline);
    res.json({ clients });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/next-number — returns next available numeric invoice number
const nextOrderNumber = async (req, res) => {
  try {
    const orders = await Order.find({ orderNumber: /^\d+$/ }).select('orderNumber').lean();
    const max = orders.reduce((m, o) => Math.max(m, parseInt(o.orderNumber, 10) || 0), 1036);
    res.json({ next: String(max + 1) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/:id
const getOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json(order);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders
const createOrder = async (req, res) => {
  try {
    const order = await Order.create(req.body);
    res.status(201).json(order);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

// PUT /api/orders/:id
const updateOrder = async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true },
    ).lean();
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json(order);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

// DELETE /api/orders/:id
const deleteOrder = async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/company/:name — orders for one company (for Client Hub)
const listByCompany = async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const orders = await Order.find({
      $or: [{ companyName: re }, { clientName: re }],
    }).sort({ orderDate: -1, createdAt: -1 }).lean();
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/rename-company — merge one company name into another.
// Also retargets mockup library items so their thumbnails follow the rename.
const renameCompany = async (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ message: 'from and to are required' });
    const ordersResult = await Order.updateMany(
      { $or: [{ companyName: from }, { clientName: from }] },
      { $set: { companyName: to, companyKey: deriveCompanyKey(to, '') } },
    );
    const mockupsResult = await StudioLibraryItem.updateMany(
      { store: 'mockups', client: from },
      { $set: { client: to } },
    );
    res.json({
      updated: ordersResult.modifiedCount,
      mockupsUpdated: mockupsResult.modifiedCount,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// DELETE /api/orders/by-company/:name — delete all orders for a company (used in dedupe cleanup)
const deleteByCompany = async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const result = await Order.deleteMany({ companyName: name });
    res.json({ deleted: result.deletedCount });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/import-quotes — bulk import from Google Drive Apps Script export
const importQuotes = async (req, res) => {
  try {
    const quotes = req.body;
    if (!Array.isArray(quotes)) return res.status(400).json({ message: 'Expected a JSON array' });

    let created = 0, skipped = 0;
    for (const q of quotes) {
      if (!q.companyName) { skipped++; continue; }
      // Deduplicate by companyName + notes (which encodes the source file + sheet)
      const exists = await Order.findOne({
        companyName: q.companyName,
        notes: q.notes,
        importedFrom: 'gdrive_quoter',
      }).lean();
      if (exists) { skipped++; continue; }
      await Order.create({
        companyName:   q.companyName || '',
        clientName:    q.clientName  || '',
        status:        'quoted',
        totalValue:    Number(q.totalValue) || 0,
        cogs:          Number(q.cogs)       || 0,
        notes:         q.notes       || '',
        items:         Array.isArray(q.items) ? q.items : [],
        importedFrom:  'gdrive_quoter',
        orderDate:     q.orderDate ? new Date(q.orderDate) : null,
      });
      created++;
    }
    res.json({ created, skipped });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/:id/files — upload a design file (multer applied in route)
const uploadFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file provided' });
    const meta = {
      filename:     req.file.filename,
      originalName: req.file.originalname,
      mimetype:     req.file.mimetype,
      size:         req.file.size,
      uploadedAt:   new Date(),
    };
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { $push: { files: meta } },
      { new: true },
    ).lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(meta);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// DELETE /api/orders/:id/files/:filename
const deleteFile = async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const filepath = path.join(__dirname, '..', 'uploads', req.params.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    await Order.findByIdAndUpdate(req.params.id, {
      $pull: { files: { filename: req.params.filename } },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/:id/files/:filename — serve file with auth
const serveFile = async (req, res) => {
  try {
    const path = require('path');
    const filepath = path.join(__dirname, '..', 'uploads', req.params.filename);
    res.sendFile(filepath);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/dashboard — single-roundtrip overview for the new home screen.
// Returns: { actionQueue, kpis, recentActivity, topClients }.
const dashboard = async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const fiveDaysAgo  = new Date(now.getTime() - 5  * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const startOfYear  = new Date(now.getFullYear(), 0, 1);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [facet] = await Order.aggregate([
      { $facet: {
        kpis: [
          { $group: {
            _id: null,
            revenueAllTime:   { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$totalValue', 0] } },
            revenueThisYear:  { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'delivered'] }, { $gte: ['$orderDate', startOfYear] }] }, '$totalValue', 0] } },
            revenueThisMonth: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'delivered'] }, { $gte: ['$orderDate', startOfMonth] }] }, '$totalValue', 0] } },
            openOrders:       { $sum: { $cond: [{ $in: ['$status', ['approved', 'placed', 'in_production', 'shipped']] }, 1, 0] } },
            openQuotes:       { $sum: { $cond: [{ $eq: ['$status', 'quoted'] }, 1, 0] } },
          }},
        ],
        staleQuotes: [
          { $match: { status: 'quoted', createdAt: { $lt: sevenDaysAgo }, $or: [{ mockupNumbers: { $size: 0 } }, { mockupNumbers: { $exists: false } }] } },
          { $sort: { createdAt: 1 } },
          { $limit: 10 },
          { $project: { _id: 1, companyName: 1, clientName: 1, totalValue: 1, createdAt: 1 } },
        ],
        missingMockups: [
          { $match: { status: { $in: ['placed', 'in_production'] }, $or: [{ mockupNumbers: { $size: 0 } }, { mockupNumbers: { $exists: false } }] } },
          { $sort: { orderDate: 1 } },
          { $limit: 10 },
          { $project: { _id: 1, orderNumber: 1, companyName: 1, clientName: 1, status: 1, orderDate: 1 } },
        ],
        overdueShipped: [
          { $match: { status: 'shipped', shipDate: { $lt: fiveDaysAgo }, deliveredDate: { $in: [null, undefined] } } },
          { $sort: { shipDate: 1 } },
          { $limit: 10 },
          { $project: { _id: 1, orderNumber: 1, companyName: 1, clientName: 1, shipDate: 1 } },
        ],
        atRiskProjects: [
          { $match: { status: 'in_production', updatedAt: { $lt: fourteenDaysAgo } } },
          { $sort: { updatedAt: 1 } },
          { $limit: 10 },
          { $project: { _id: 1, orderNumber: 1, companyName: 1, clientName: 1, updatedAt: 1 } },
        ],
        recentActivity: [
          { $sort: { updatedAt: -1 } },
          { $limit: 15 },
          { $project: { _id: 1, orderNumber: 1, companyName: 1, clientName: 1, status: 1, totalValue: 1, updatedAt: 1 } },
        ],
        topClients: [
          { $match: { status: 'delivered' } },
          { $group: {
            _id: {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ['$companyKey', ''] } }, 0] },
                '$companyKey',
                { $toLower: { $ifNull: ['$companyName', '$clientName'] } },
              ],
            },
            companyName:  { $first: '$companyName' },
            clientName:   { $first: '$clientName' },
            totalRevenue: { $sum: '$totalValue' },
            orderCount:   { $sum: 1 },
          }},
          { $sort: { totalRevenue: -1 } },
          { $limit: 5 },
        ],
        activeLeads: [
          { $group: {
            _id: {
              $cond: [
                { $gt: [{ $strLenCP: { $ifNull: ['$companyKey', ''] } }, 0] },
                '$companyKey',
                { $toLower: { $ifNull: ['$companyName', '$clientName'] } },
              ],
            },
            statuses: { $addToSet: '$status' },
          }},
          { $match: { 'statuses': { $not: { $elemMatch: { $in: CLIENT_TIER_STATUSES } } } } },
          { $count: 'count' },
        ],
      }},
    ]);

    const [newInquiries, totalNewInquiries] = await Promise.all([
      ContactSubmission.find({ status: 'new', honeypot: { $ne: true } })
        .sort({ createdAt: -1 }).limit(10)
        .select('_id name companyName email createdAt seenByAdmin')
        .lean(),
      ContactSubmission.countDocuments({ status: 'new', honeypot: { $ne: true } }),
    ]);

    const kpis = facet.kpis[0] || {};
    res.json({
      actionQueue: {
        newInquiries,
        newInquiriesTotal: totalNewInquiries,
        staleQuotes:     facet.staleQuotes,
        missingMockups:  facet.missingMockups,
        overdueShipped:  facet.overdueShipped,
        atRiskProjects:  facet.atRiskProjects,
      },
      kpis: {
        revenueAllTime:   kpis.revenueAllTime   || 0,
        revenueThisYear:  kpis.revenueThisYear  || 0,
        revenueThisMonth: kpis.revenueThisMonth || 0,
        openOrders:       kpis.openOrders       || 0,
        openQuotes:       kpis.openQuotes       || 0,
        activeLeads:      (facet.activeLeads[0] && facet.activeLeads[0].count) || 0,
      },
      recentActivity: facet.recentActivity,
      topClients:     facet.topClients,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/from-submission/:submissionId — manual inquiry → project bridge.
// Creates an Order(status='quoted', contactSubmissionId, prefilled from submission),
// flips the submission to status='quoted' and stores orderId.
const createFromSubmission = async (req, res) => {
  try {
    const sub = await ContactSubmission.findById(req.params.submissionId);
    if (!sub) return res.status(404).json({ message: 'Submission not found' });
    if (sub.orderId) {
      const existing = await Order.findById(sub.orderId).lean();
      if (existing) return res.json({ order: existing, alreadyLinked: true });
    }

    const notes = [
      sub.notes && `Inquiry notes: ${sub.notes}`,
      sub.quantity && `Quantity: ${sub.quantity}`,
      sub.inHandDate && `In-hand by: ${sub.inHandDate}`,
      sub.shipToState && `Ship to: ${sub.shipToState}`,
    ].filter(Boolean).join('\n');

    const order = await Order.create({
      companyName:         sub.companyName || '',
      clientName:          sub.name || '',
      status:              'quoted',
      notes,
      contactSubmissionId: sub._id,
      importedFrom:        'inquiry',
    });

    sub.status  = 'quoted';
    sub.orderId = order._id;
    await sub.save();

    res.status(201).json({ order: order.toObject() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  listOrders, listClients, getOrder, createOrder, updateOrder, deleteOrder,
  listByCompany, seedHistorical, nextOrderNumber, uploadFile, deleteFile, serveFile,
  importQuotes, renameCompany, deleteByCompany, dashboard, createFromSubmission,
};
