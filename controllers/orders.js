const Order = require('../models/Order');

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

// GET /api/orders/clients — distinct companies with stats
const listClients = async (req, res) => {
  try {
    const pipeline = [
      { $group: {
        _id: { $toLower: { $ifNull: ['$companyName', '$clientName'] } },
        companyName:   { $first: '$companyName' },
        clientName:    { $first: '$clientName' },
        orderCount:    { $sum: 1 },
        totalRevenue:  { $sum: '$totalValue' },
        lastOrderDate: { $max: '$orderDate' },
        lastActivity:  { $max: '$createdAt' },
        statuses:      { $addToSet: '$status' },
      }},
      { $sort: { lastActivity: -1 } },
    ];
    const clients = await Order.aggregate(pipeline);
    res.json({ clients });
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

module.exports = { listOrders, listClients, getOrder, createOrder, updateOrder, deleteOrder, listByCompany };
