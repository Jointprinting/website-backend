const Client = require('../models/Client');
const Order  = require('../models/Order');
const { deriveCompanyKey } = require('../models/Order');

// GET /api/clients — every client profile
const listClients = async (req, res) => {
  try {
    const clients = await Client.find({}).sort({ companyName: 1 }).lean();
    res.json({ clients });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/clients/:companyKey — single profile, creates an empty stub if
// missing (so the drawer always has a record to edit and our defaults
// auto-fill works on the very first project for a new client too).
const getOrCreate = async (req, res) => {
  try {
    const key = req.params.companyKey;
    let client = await Client.findOne({ companyKey: key }).lean();
    if (!client) {
      // Bootstrap from any existing order for this company — fills in the
      // basic names so the drawer isn't blank.
      const sample = await Order.findOne({ companyKey: key })
        .sort({ updatedAt: -1 })
        .select('companyName clientName')
        .lean();
      client = await Client.create({
        companyKey: key,
        companyName: (sample && sample.companyName) || '',
        clientName:  (sample && sample.clientName)  || '',
      });
      client = client.toObject();
    }
    res.json({ client });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// PUT /api/clients/:companyKey — upsert by key
const upsert = async (req, res) => {
  try {
    const key = req.params.companyKey;
    if (!key) return res.status(400).json({ message: 'companyKey required' });
    const allowed = ['companyName', 'clientName', 'email', 'phone',
      'paymentTerms', 'defaultPrinter', 'defaultSupplier', 'defaultMarkup', 'notes'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.companyKey = key;
    const client = await Client.findOneAndUpdate(
      { companyKey: key },
      { $set: patch },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    res.json({ client });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Helper used by orders controller on create: returns prefilled values from
// the client profile (printer/supplier/markup/payment terms). Returns null
// if no profile exists yet.
async function getDefaultsFor(companyName, clientName) {
  const key = deriveCompanyKey(companyName, clientName);
  if (!key) return null;
  return Client.findOne({ companyKey: key }).lean();
}

module.exports = { listClients, getOrCreate, upsert, getDefaultsFor };
