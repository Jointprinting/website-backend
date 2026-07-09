const Order = require('../models/Order');
const Transaction = require('../models/Transaction');
const ContactSubmission = require('../models/ContactSubmission');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const PurchaseOrder = require('../models/PurchaseOrder');
// REUSE the canonical key + the single PLACED_STATUSES list so "placed order"
// means exactly the same thing here as in the CRM.
const { deriveCompanyKey, PLACED_STATUSES } = require('../models/Order');
const { normalizeOrderNumber, orderActualCost } = require('./finances');
const { getDefaultsFor } = require('./clients');
// REUSE the CRM's customer-promotion (which itself reuses promoteStage) so a
// placed order bumps the company to 'customer' without ever regressing a
// won/lost/dormant record. Order writes never depend on this succeeding.
const { promoteCompanyToCustomerOnPlacement, ensureCompanyForQuoting } = require('./crm');
const { nextNumber, bumpCounterTo } = require('../utils/sequence');
const { etToday, etDayKey } = require('../utils/time');
const r2 = require('../services/r2');

// True when an order status counts as a REAL placed order (a customer signal).
const isPlacedStatus = (s) => PLACED_STATUSES.includes(s);

// Best-effort: a placed order means the company is a customer. Promote its CRM
// record (UP-only; never touches won/lost/dormant). Wrapped so a CRM hiccup can
// NEVER fail the order write that triggered it — we only log and move on.
async function bumpCustomerOnPlacement(order) {
  try {
    if (!order || !isPlacedStatus(order.status)) return;
    const key = order.companyKey || deriveCompanyKey(order.companyName, order.clientName);
    await promoteCompanyToCustomerOnPlacement(key, {
      companyName: order.companyName || '',
      clientName:  order.clientName  || '',
    });
  } catch (e) {
    console.warn('[orders] customer auto-promote skipped:', e.message);
  }
}

// ─── Notion seed data ─────────────────────────────────────────────────────────
// Exported from the Notion "Orders" database (the source of truth). Project #
// is what Notion calls "Order #" — the canonical project ID, sequential and
// gappy. Invoice # is assigned at approval (= when client signs off the
// confirmation page), continuing from Notion's last invoice.

function _parseMockupNumbers(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (/^N\/A/i.test(s)) return [];
  // Strip leading hash if any, split on + or , — accept "41C,K,M,G", "000005A+B",
  // "000064A-R" (range), "000062A,B,C,D,...,O" (long list), etc.
  const stripped = s.replace(/\s/g, '').replace(/^#/, '');
  // Range form: "000064A-R" → expand A through R as separate mockups
  const rangeMatch = stripped.match(/^(\d+)([A-Za-z])-([A-Za-z])$/);
  if (rangeMatch) {
    const base = rangeMatch[1].padStart(6, '0');
    const start = rangeMatch[2].toUpperCase().charCodeAt(0);
    const end   = rangeMatch[3].toUpperCase().charCodeAt(0);
    const out = [];
    for (let c = start; c <= end; c++) out.push(`#${base}${String.fromCharCode(c)}`);
    return out;
  }
  const parts = stripped.split(/[+,]/);
  const head = parts[0].match(/^(\d+)([A-Za-z]*)$/);
  if (!head) return [];
  const base = head[1].padStart(6, '0');
  const letters = [head[2], ...parts.slice(1)].filter(Boolean);
  if (letters.length === 0) return [`#${base}`];
  return letters.map(l => `#${base}${l.toUpperCase()}`);
}

function _parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function _statusFrom(row) {
  const ship = (row.shipment || '').toLowerCase();
  const pay  = (row.paid || '').toLowerCase();
  if (pay === 'voided') return 'cancelled';
  if (ship === 'arrived') return 'delivered';
  if (ship === 'at printer') return 'in_production';
  if (ship === 'not started') return 'placed';
  if (row.invoice && pay === 'paid') return 'delivered'; // service/consulting paid
  if (row.invoice) return 'approved';
  return 'quoted';
}

// Full extract from the Notion Orders database (CSV export, May 2026).
// Project # column comes straight from Notion as "Order #".
const HISTORICAL_ORDERS = [
  { project: '1',     company: 'Jotkoff Financial Services',    clientName: 'Ryan Jotkoff',           invoice: '1001', invoiced: 1682.86, cogs: 844.21,  dateOfSale: '6/5/2024',    items: '50 polos, pocket embroidery',                                  mockup: '000001B',                  printer: 'Apollo East',             supplier: 'Alphabroder',                       paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '6/20/2024',  arriveAtPrinter: '6/10/2024' },
  { project: '5',     company: 'Electric Starship Arcade',      clientName: 'Mike Woods',             invoice: '1002', invoiced: 1338.87, cogs: 776.58,  dateOfSale: '7/4/2024',    items: '100 shirts, chest screen print',                               mockup: '000005A+B',                printer: 'Apollo East',             supplier: 'Alphabroder',                       paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '7/23/2024',  arriveAtPrinter: '7/8/2024'  },
  { project: '10',    company: 'Jotkoff Financial Services',    clientName: 'Ryan Jotkoff',           invoice: '1003', invoiced: 416.49,  cogs: 248.88,  dateOfSale: '9/12/2024',   items: "24 women's polos, pocket embroidery",                          mockup: '000010A',                  printer: 'Ace Screen Printing',     supplier: 'S&S Activewear',                    paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '9/24/2024',  arriveAtPrinter: '9/17/2024' },
  { project: '20',    company: 'Stadium Gardens',               clientName: 'Rita Tsalyuk',           invoice: '1004', invoiced: 4545.00, cogs: 3984.94, dateOfSale: '10/31/2024',  items: '30,000 paper bags',                                            mockup: '000019C',                  printer: '',                        supplier: 'Alibaba',                           paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '12/20/2024', notes: 'FUTURE $100 DISCOUNT' },
  { project: '21',    company: 'NJ Dental 1',                   clientName: 'Alex Gelman',            invoice: '1005', invoiced: 841.69,  cogs: 443.24,  dateOfSale: '11/20/2024',  items: '500 toothbrushes',                                             mockup: 'N/A',                      printer: '',                        supplier: 'Tekweld',                           paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '12/1/2024'  },
  { project: '24',    company: "Earl and Tom's Dispensary",     clientName: 'Nicole Romero',          invoice: '1009', invoiced: 551.00,  cogs: 362.93,  dateOfSale: '3/15/2025',   items: '250 glass pipes (chillums)',                                   mockup: 'N/A',                      printer: '',                        supplier: 'Cannabis Promotions',               paid: 'Voided', shipment: 'Arrived',     arriveAtClient: '4/4/2025'   },
  { project: '24-2',  company: "Earl and Tom's Dispensary",     clientName: 'Nicole Romero',          invoice: '1019', invoiced: 545.85,  cogs: 347.93,  dateOfSale: '3/27/2025',   items: '250 glass pipes (chillums)',                                   mockup: 'N/A',                      printer: '',                        supplier: 'Cannabis Promotions',               paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '4/4/2025'   },
  { project: '22-1',  company: "Shaggy's Baggy",                clientName: 'Keegan Lapointe',        invoice: '1018', invoiced: 689.00,  cogs: 564.91,  dateOfSale: '3/11/2025',   items: '300 lighters',                                                 mockup: 'N/A',                      printer: '',                        supplier: 'Cannabis Promotions',               paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '3/29/2025'  },
  { project: '22-2',  company: "Shaggy's Baggy",                clientName: 'Keegan Lapointe',        invoice: '1020', invoiced: 918.57,  cogs: 846.58,  dateOfSale: '3/27/2025',   items: '30 hoodies',                                                   mockup: '21H',                      printer: 'Ace Screen Printing',     supplier: 'S&S Activewear',                    paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '4/13/2025'  },
  { project: '30',    company: 'Bract House',                   clientName: 'Thomas Calmese',         invoice: '1021', invoiced: 8321.39, cogs: 7714.24, dateOfSale: '3/28/2025',   items: '1,100 T-shirts',                                               mockup: '33L',                      printer: 'Ace Screen Printing',     supplier: 'Alphabroder',                       paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '4/17/2025',  arriveAtPrinter: '4/5/2025'  },
  { project: '31',    company: 'Cannapi',                       clientName: 'Jocelyn Melo',           invoice: '1012', invoiced: 1906.34, cogs: 1454.79, dateOfSale: '12/13/2024',  items: '50 beanies embroidery + 50 hoodies screen print',              mockup: '000024F+D+E+H+I',          printer: 'Apollo East',             supplier: 'Alphabroder',                       paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '12/29/2024' },
  { project: '39',    company: 'OS NYC',                        clientName: 'Daequan Langhorn',       invoice: '1014', invoiced: 1117.14, cogs: 942.78,  dateOfSale: '1/19/2025',   items: '54 hoodies + long sleeves, screen print',                      mockup: '000023A+B',                printer: 'Apollo East',             supplier: 'Alphabroder',                       paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '2/2/2025'   },
  { project: '61',    company: 'The CannaBoss Lady',            clientName: 'Jill Cohen',             invoice: '1016', invoiced: 907.05,  cogs: 820.56,  dateOfSale: '2/24/2025',   items: '300 lighters + 2 buttermint cases',                            mockup: 'N/A',                      printer: '',                        supplier: 'Cannabis Promotions + Mount Franklin Foods', paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '3/10/2025'  },
  { project: '65',    company: 'Point In Time Studios',         clientName: 'Elizabeth Brockmann',    invoice: '1015', invoiced: 1065.53, cogs: 716.58,  dateOfSale: '2/20/2025',   items: '20 shirts + 20 hats, screen print',                            mockup: '29D+E',                    printer: 'Ace Screen Printing',     supplier: 'Alphabroder + S&S Activewear',      paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '3/10/2025'  },
  { project: '82',    company: 'OS NYC',                        clientName: 'Daequan Langhorn',       invoice: '1027', invoiced: 913.01,  cogs: 698.93,  dateOfSale: '7/9/2025',    items: '25 jerseys + 25 T-shirts',                                     mockup: '49A,B',                    printer: 'Heritage Screen Printing',supplier: 'S&S Activewear + Sanmar',           paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '7/23/2025'  },
  { project: '83-1',  company: 'The CannaBoss Lady',            clientName: 'Jill Cohen',             invoice: '1023', invoiced: 3318.34, cogs: 2466.04, dateOfSale: '5/30/2025',   items: '200 T-shirts, 250 lip balm',                                   mockup: '41C,K,M,G',                printer: 'Contract-DTG',            supplier: 'S&S Activewear + Tekweld',          paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '6/17/2025'  },
  { project: '83-2',  company: 'The CannaBoss Lady',            clientName: 'Jill Cohen',             invoice: '1023', invoiced: 143.51,  cogs: 107.55,  dateOfSale: '7/2/2025',    items: '200 T-shirts, 250 lip balm (add-on)',                          mockup: '41C,K,M,G',                printer: 'Contract-DTG',            supplier: 'S&S Activewear',                    paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '7/18/2025'  },
  { project: '91',    company: 'Sauce Me A Fry',                clientName: 'Jason Grandizio',        invoice: '1022', invoiced: 1875.26, cogs: 1191.48, dateOfSale: '5/14/2025',   items: '100 T-shirts',                                                 mockup: '40E+F',                    printer: 'Heritage Screen Printing',supplier: 'S&S Activewear',                    paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '5/29/2025',  arriveAtPrinter: '5/20/2025' },
  { project: '93',    company: 'The CannaBoss Lady',            clientName: 'Jill Cohen',             invoice: '1025', invoiced: 2756.30, cogs: 2194.98, dateOfSale: '6/30/2025',   items: '250 totes, 600 Bic lighters',                                  mockup: '43A,B',                    printer: 'Heritage Screen Printing',supplier: 'S&S Activewear + Cannabis Promotions', paid: 'Paid', shipment: 'Arrived',    arriveAtClient: '7/15/2025'  },
  { project: '106',   company: 'Human AF',                      clientName: 'Shawn Hill / Amber Theurer', invoice: '1030', invoiced: 218.53, cogs: 0,    dateOfSale: '9/17/2025',   items: '1 hoodie + 1 hat',                                             mockup: '55B,D',                    printer: 'Heritage Screen Printing',supplier: 'S&S Activewear + Sanmar',           paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '9/30/2025'  },
  { project: '107',   company: 'Stadium Gardens',               clientName: 'Rita Tsalyuk',           invoice: '1029', invoiced: 5600.00, cogs: 4758.14, dateOfSale: '9/17/2025',   items: '40,000 paper bags',                                            mockup: '56A',                      printer: '',                        supplier: 'Alibaba',                           paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '11/27/2025', notes: 'FUTURE $100 DISCOUNT' },
  { project: '108',   company: 'NJ Dental 1',                   clientName: 'Alex Gelman',            invoice: '1031', invoiced: 642.41,  cogs: 374.00,  dateOfSale: '10/1/2025',   items: '500 toothbrushes',                                             mockup: 'N/A',                      printer: '',                        supplier: 'Tekweld',                           paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '10/20/2025' },
  { project: '109',   company: 'Vantage Real Estate',           clientName: "Ma'or Hemo",             invoice: '1032', invoiced: 180.65,  cogs: 142.21,  dateOfSale: '11/3/2025',   items: '20 linen kippahs',                                             mockup: 'N/A',                      printer: '',                        supplier: 'RedTupid',                          paid: 'Paid',   shipment: 'Arrived',     arriveAtClient: '11/20/2025' },
  { project: '111',   company: 'M4JI',                          clientName: 'Maji',                   invoice: '',     invoiced: 0,       cogs: 1070.58, dateOfSale: '',            items: '25 hoodies + 25 T-shirts',                                     mockup: '000060A+B',                printer: '',                        supplier: '',                                  paid: '',       shipment: 'Not Started' },
  { project: '112',   company: 'VT3D',                          clientName: '',                       invoice: '1034', invoiced: 4289.70, cogs: 0,       dateOfSale: '12/3/2025',   items: 'Brand consulting',                                             mockup: 'N/A',                      printer: '',                        supplier: '',                                  paid: 'Paid',   shipment: 'Arrived' },
  { project: '113',   company: 'VT3D',                          clientName: '',                       invoice: '1035', invoiced: 2101.00, cogs: 0,       dateOfSale: '1/5/2026',    items: 'Brand consulting',                                             mockup: 'N/A',                      printer: '',                        supplier: '',                                  paid: 'Paid',   shipment: '' },
  { project: '114',   company: 'The CannaBoss Lady',            clientName: 'Jill Cohen',             invoice: '1036', invoiced: 4852.89, cogs: 3262.08, dateOfSale: '12/8/2025',   items: '200 hoodies',                                                  mockup: '000061A,B,C,D',            printer: 'Contract-DTG',            supplier: 'S&S Activewear',                    paid: 'Paid',   shipment: 'At Printer',  arriveAtClient: '1/6/2026',   arriveAtPrinter: '12/17/2025' },
  { project: '115',   company: 'Voodoo Brewing Co -> Good Company', clientName: '',                  invoice: '1037', invoiced: 5405.06, cogs: 0,       dateOfSale: '12/11/2025',  items: '146 long sleeves, 20 hoodies, 20 crewnecks, 40 hats, 40 beanies', mockup: '000062A-O',                printer: 'BlueFrog',                supplier: 'S&S + Sanmar (hats)',               paid: 'Paid',   shipment: 'At Printer',  arriveAtClient: '1/9/2026',   arriveAtPrinter: '1/2/2026'  },
  { project: '120',   company: 'Duckies Revenge Arcade',        clientName: '',                       invoice: '1038', invoiced: 1436.73, cogs: 0,       dateOfSale: '12/15/2025',  items: '50 T-shirts + 25 hoodies',                                     mockup: '000063B,E',                printer: 'Oklahoma Ink',            supplier: 'S&S Activewear',                    paid: 'Paid',   shipment: 'At Printer',  arriveAtClient: '1/4/2026',   arriveAtPrinter: '12/29/2025' },
  { project: '121',   company: 'VT3D',                          clientName: '',                       invoice: '1039', invoiced: 1746.10, cogs: 0,       dateOfSale: '2/2/2026',    items: 'Brand consulting',                                             mockup: 'N/A',                      printer: '',                        supplier: '',                                  paid: 'Paid',   shipment: '' },
  { project: '122',   company: 'Mad Martian Farms',             clientName: '',                       invoice: '1040', invoiced: 3557.27, cogs: 0,       dateOfSale: '2/1/2026',    items: 'Trays, lighters, stickers, grinders, ash trays',               mockup: 'N/A',                      printer: '',                        supplier: 'Cannabis Promotions, Full Designs', paid: 'Unpaid', shipment: 'Not Started' },
  { project: '123',   company: 'VT3D',                          clientName: '',                       invoice: '1041', invoiced: 1773.00, cogs: 0,       dateOfSale: '',            items: 'Brand consulting',                                             mockup: 'N/A',                      printer: '',                        supplier: '',                                  paid: 'Paid',   shipment: '' },
  { project: '124',   company: 'VT3D',                          clientName: '',                       invoice: '1041', invoiced: 788.27,  cogs: 0,       dateOfSale: '',            items: 'Brand consulting',                                             mockup: '',                         printer: '',                        supplier: '',                                  paid: 'Paid',   shipment: '' },
  { project: '125',   company: 'The CannaBoss Lady',            clientName: 'Jill Cohen',             invoice: '',     invoiced: 0,       cogs: 0,       dateOfSale: '',            items: '',                                                             mockup: '',                         printer: '',                        supplier: '',                                  paid: '',       shipment: '' },
  { project: '126',   company: "Shaggy's Baggy",                clientName: 'Keegan Lapointe',        invoice: '1042', invoiced: 815.68,  cogs: 576.49,  dateOfSale: '2/25/2026',   items: '300 lighters',                                                 mockup: 'N/A',                      printer: 'Bic World',               supplier: 'Bic World',                         paid: 'Paid',   shipment: 'Arrived' },
  { project: '127',   company: 'Swan Rose Holdings',            clientName: '',                       invoice: '',     invoiced: 0,       cogs: 0,       dateOfSale: '',            items: 'Merch line (Cannabis Connoisseur / Premier High Life / Mush Love / New Era / Alter Ego)', mockup: '000064A-R',                printer: '',                        supplier: '',                                  paid: '',       shipment: '' },
  { project: '128',   company: 'VT3D',                          clientName: '',                       invoice: '1043', invoiced: 676.61,  cogs: 0,       dateOfSale: '',            items: 'Brand consulting',                                             mockup: '',                         printer: '',                        supplier: '',                                  paid: 'Paid',   shipment: '' },
  { project: '129',   company: 'Stadium Gardens',               clientName: 'Rita Tsalyuk',           invoice: '1044', invoiced: 5600.00, cogs: 4787.44, dateOfSale: '',            items: '40,000 paper bags',                                            mockup: '56A',                      printer: '',                        supplier: 'Alibaba',                           paid: 'Paid',   shipment: 'Arrived',     notes: 'JP pays 167.44 (2.99%) QB CC fee' },
  { project: '130',   company: 'Harvest Moon Farms',            clientName: '',                       invoice: '',     invoiced: 0,       cogs: 0,       dateOfSale: '',            items: 'stands, shelves',                                              mockup: '',                         printer: '',                        supplier: '',                                  paid: '',       shipment: '' },
  { project: '131',   company: 'Sauce Me A Fry',                clientName: 'Jason Grandizio',        invoice: '1045', invoiced: 477.36,  cogs: 0,       dateOfSale: '',            items: 'embroidered hats',                                             mockup: '000066A',                  printer: 'Heritage Screen Printing',supplier: 'S&S Activewear',                    paid: 'Paid',   shipment: 'At Printer',  notes: 'waived CC fee - 2.99%' },
  { project: '132',   company: 'Bleu Leaf Dispensary',          clientName: '',                       invoice: '',     invoiced: 0,       cogs: 0,       dateOfSale: '',            items: 'womens shirts + shorts',                                       mockup: '000067',                   printer: '',                        supplier: '',                                  paid: '',       shipment: '' },
  { project: '133',   company: 'Dredo',                         clientName: 'Dredo',                  invoice: '1046', invoiced: 1651.19, cogs: 0,       dateOfSale: '',            items: 'shirts, polos, hoodies, crewnecks',                            mockup: '000068E,G,I',              printer: 'Heritage Screen Printing',supplier: 'S&S Activewear',                    paid: 'Unpaid', shipment: 'Not Started', notes: 'CC fee - 2.99%' },
  { project: '134',   company: 'Enlighten Dispensary',          clientName: '',                       invoice: '',     invoiced: 0,       cogs: 0,       dateOfSale: '',            items: 'tshirts, crewnecks',                                           mockup: '000069',                   printer: '',                        supplier: '',                                  paid: '',       shipment: '' },
  { project: '135',   company: 'Highway 90',                    clientName: '',                       invoice: '',     invoiced: 0,       cogs: 0,       dateOfSale: '',            items: 'tshirts',                                                      mockup: '000070',                   printer: '',                        supplier: '',                                  paid: '',       shipment: '' },
];

// POST /api/orders/seed-historical
// Idempotent re-seed from Notion: wipes any stale gdrive_quoter junk, then for
// every row in HISTORICAL_ORDERS either creates a new Order or updates the
// existing one (matched by projectNumber). Safe to run repeatedly.
const seedHistorical = async (req, res) => {
  try {
    const gdriveWiped = await Order.deleteMany({ importedFrom: 'gdrive_quoter' });

    let created = 0, updated = 0;
    for (const row of HISTORICAL_ORDERS) {
      const mockupNumbers = _parseMockupNumbers(row.mockup);
      const status        = _statusFrom(row);
      const fields = {
        projectNumber:  row.project,
        orderNumber:    row.invoice || '',
        companyName:    row.company || '',
        clientName:     row.clientName || '',
        companyKey:     deriveCompanyKey(row.company, row.clientName),
        status,
        paid:           (row.paid || '').toLowerCase() === 'paid',
        totalValue:     Number(row.invoiced) || 0,
        cogs:           Number(row.cogs) || 0,
        printerName:    row.printer || '',
        supplier:       row.supplier || '',
        notes:          row.notes || '',
        mockupNumbers,
        items:          row.items ? [{ description: row.items, qty: 0, unitPrice: 0 }] : [],
        orderDate:      _parseDate(row.dateOfSale),
        shipDate:       _parseDate(row.arriveAtPrinter),
        deliveredDate:  _parseDate(row.arriveAtClient),
        importedFrom:   'notion',
      };

      const existing = await Order.findOne({ projectNumber: row.project });
      if (existing) {
        await Order.updateOne({ _id: existing._id }, { $set: fields });
        updated++;
      } else {
        await Order.create(fields);
        created++;
      }
    }
    res.json({
      gdriveWiped: gdriveWiped.deletedCount,
      created,
      updated,
      total: HISTORICAL_ORDERS.length,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders?search=&status=&page=&limit=
const listOrders = async (req, res) => {
  try {
    const { search = '', status, page = 1, limit = 200 } = req.query;
    const filter = {};
    if (search.trim()) {
      // Escape regex metacharacters — raw user input compiled as a pattern
      // can throw or ReDoS (matches the escaping product.js already does).
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { clientName:    re },
        { companyName:   re },
        { orderNumber:   re },
        { projectNumber: re },
        { mockupNumbers: re },
      ];
    }
    if (status) filter.status = status;
    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();
    const total = await Order.countDocuments(filter);
    res.json({ orders, total });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/projects — every project (= every Order) ordered newest first.
// This is the canonical feed for the new project-first UI.
const listProjects = async (req, res) => {
  try {
    // Exclude archived (soft-deleted / reconcile-reverted) orders — they must
    // drop out of the working list and header stats, the same way the CRM board
    // and /attention already exclude them (?archived=1 opts them back in for a
    // future recover surface).
    const q = req.query.archived === '1' ? {} : { archived: { $ne: true } };
    const orders = await Order.find(q)
      .sort({ createdAt: -1 })
      .lean();

    // Sort by numeric portion of projectNumber descending (so 135 > 134 > ... > 22-2 > 22-1 > 21).
    orders.sort((a, b) => {
      const an = parseInt((a.projectNumber || '0').split('-')[0], 10) || 0;
      const bn = parseInt((b.projectNumber || '0').split('-')[0], 10) || 0;
      if (an !== bn) return bn - an;
      return (b.projectNumber || '').localeCompare(a.projectNumber || '');
    });

    res.json({ projects: orders });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/next-numbers — returns the next project # and next invoice #
// so the UI can pre-fill them when starting a project or moving one to approved.
const nextNumbers = async (req, res) => {
  try {
    const all = await Order.find({}).select('projectNumber orderNumber').lean();
    const maxProject = all.reduce((m, o) => {
      const n = parseInt((o.projectNumber || '0').split('-')[0], 10) || 0;
      return Math.max(m, n);
    }, 0);
    const maxInvoice = all.reduce((m, o) => {
      const n = parseInt(o.orderNumber || '0', 10) || 0;
      return Math.max(m, n);
    }, 0);
    res.json({
      nextProject: String(maxProject + 1),
      nextInvoice: String(maxInvoice + 1),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// The receipt-derived ACTUAL cost for one order, attached to the order POJO. The
// real source of truth for what an order COST is the expense receipts linked to it
// by order number — not the quote/confirmation estimate (order.cogs). We compute
// it with the SAME shared finance helpers the ledger uses (normalizeOrderNumber to
// match leading-zero variants, signed()/COGS_CATEGORIES inside orderActualCost) so
// it reconciles to /api/finances by-order to the cent. Returns the order unchanged
// plus: actualCost (Σ receipts), estimatedCost (= order.cogs, the confirmation's
// estimate, kept as secondary), receiptCount, hasReceipts (false → flag a missing
// receipt in the UI), and actualMargin (revenue/totalValue − actualCost). When no
// COGS receipts are linked yet, actualCost is 0 and hasReceipts is false, so the
// UI falls back to the estimate instead of silently showing $0.
async function attachActualCost(order) {
  const key = normalizeOrderNumber(order.orderNumber);
  let rows = [];
  if (key) {
    rows = await Transaction.find({ type: 'expense', orderNumber: new RegExp(`^0*${key}$`) })
      .select('type category amount isCredit orderNumber receiptUrl').lean();
  }
  const a = orderActualCost(rows);
  const totalValue = Number(order.totalValue) || 0;
  const estimatedCost = Number(order.cogs) || 0;
  const actualMargin = totalValue > 0
    ? Math.round(((totalValue - a.actualCost) / totalValue) * 10000) / 100
    : 0;
  return {
    ...order,
    actualCost: a.actualCost,
    estimatedCost,
    receiptCount: a.receiptCount,
    cogsLineCount: a.cogsLines,
    hasReceipts: a.hasReceipts,
    actualMargin,
  };
}

// GET /api/orders/:id
const getOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json(await attachActualCost(order));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Revenue + COGS implied by a confirmation (the approved doc). Revenue = each
// item's size rows (qty × unitPrice) plus the custom add-on lines (flat or %);
// COGS = each item's total qty × the internal unitCost carried over from the
// quote (confirmations never show cost to the client). Mirrors the frontend
// confRevenue/confCogs in _shared.js — keep the two in sync.
function _confirmationTotals(conf) {
  if (!conf || !Array.isArray(conf.items)) return { revenue: 0, cogs: 0 };
  // Revenue = the order's grand total from the ONE canonical function (the
  // double-tax guard C3 and cent-rounding H4 live there), so body.totalValue set
  // here always agrees with the model's own computeConfirmationTotals. COGS stays
  // unitCost-based (the confirmation carries no client-facing cost).
  const revenue = Order.computeConfirmationTotals(conf).grandTotal;
  const cogs = conf.items.reduce((s, it) => {
    const qty = (it.sizes || []).reduce((q, sz) => q + (Number(sz.qty) || 0), 0);
    return s + qty * (Number(it.unitCost) || 0);
  }, 0);
  return { revenue, cogs };
}

// Offload any base64 images embedded in a confirmation sub-document to R2,
// replacing them with public URLs. Mutates and returns the confirmation. Safe
// to call when R2 is off (no-op) — uploadDataUrl passes non-base64 values
// through. This is what keeps an order with many product images well under
// Mongo's 16MB doc limit and the client approval link fast.
async function _offloadConfirmationImages(confirmation) {
  if (!r2.isR2Configured() || !confirmation || !Array.isArray(confirmation.items)) return confirmation;
  // Per-image fallback: if an R2 upload fails (transient error or a bad key),
  // keep the original base64 so the order save never fails because of it.
  const safe = async (v) => {
    try { return await r2.uploadDataUrl(v, 'confirmations/img'); }
    catch (e) { console.warn('[orders] R2 upload failed, keeping inline:', e.message); return v; }
  };
  for (const it of confirmation.items) {
    if (!it) continue;
    if (it.customMockupDataUrl) it.customMockupDataUrl = await safe(it.customMockupDataUrl);
    if (Array.isArray(it.mockupSnapshots)) {
      for (const snap of it.mockupSnapshots) {
        if (snap && snap.dataUrl) snap.dataUrl = await safe(snap.dataUrl);
      }
    }
  }
  return confirmation;
}

// POST /api/orders — create a new project. If projectNumber is not supplied,
// auto-assign the next one.
const createOrder = async (req, res) => {
  try {
    const body = { ...req.body };
    if (body.confirmation) await _offloadConfirmationImages(body.confirmation);
    if (!body.projectNumber) {
      body.projectNumber = await nextNumber('project');
    } else {
      await bumpCounterTo('project', body.projectNumber);
    }

    // Prefill from the client profile if one exists for this company. Only
    // fills empty fields — never overwrites anything the caller passed in.
    try {
      const profile = await getDefaultsFor(body.companyName || '', body.clientName || '');
      if (profile) {
        if (!body.printerName && profile.defaultPrinter)  body.printerName = profile.defaultPrinter;
        if (!body.supplier    && profile.defaultSupplier) body.supplier    = profile.defaultSupplier;
      }
    } catch (_) { /* best-effort */ }

    body.activity = [{ kind: 'created', actor: 'admin', message: `Project #${body.projectNumber} created`, at: new Date() }];
    const order = await Order.create(body);
    // If this order is created already in a PLACED status, the company is a
    // customer — promote its CRM record (best-effort; never blocks the create).
    if (isPlacedStatus(order.status)) await bumpCustomerOnPlacement(order);
    res.status(201).json(order);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

// PUT /api/orders/:id — update a project. When status transitions to
// 'approved' and there's no invoice number yet, auto-assign one.
const updateOrder = async (req, res) => {
  try {
    const body = { ...req.body };
    if (body.confirmation) await _offloadConfirmationImages(body.confirmation);
    // Order money + sale date flow FROM the confirmation (the approved doc), so
    // the admin never hand-maintains them. Guarded so we never wipe a historical
    // order's manual numbers when a confirmation lacks the data (e.g. older
    // confirmations built before unitCost, or a still-empty draft).
    if (body.confirmation) {
      const { revenue, cogs } = _confirmationTotals(body.confirmation);
      if (revenue > 0) body.totalValue = revenue;
      if (cogs > 0) body.cogs = cogs;
      if (body.confirmation.orderDate) body.orderDate = body.confirmation.orderDate;
    }
    const current = await Order.findById(req.params.id).select('status paid orderNumber confirmation.publishedAt').lean();
    if (!current) return res.status(404).json({ message: 'Not found' });

    // The confirmation PUBLISH GATE is server-owned — only POST /confirmation/publish
    // sets it. A builder autosave sends the whole confirmation object, and $set
    // replaces the subdoc; without this, that save would drop publishedAt and
    // silently un-publish a live confirmation (bouncing the client back to the
    // "we're finalizing" waiting screen). Carry the existing stamp through every
    // confirmation write so only the publish endpoint can ever change it.
    if (body.confirmation) {
      body.confirmation.publishedAt = (current.confirmation && current.confirmation.publishedAt) || null;
    }

    // Auto-assign invoice number on first transition to approved+.
    if (body.status === 'approved' || ['placed', 'in_production', 'shipped', 'delivered'].includes(body.status)) {
      if (!current.orderNumber && !body.orderNumber) {
        body.orderNumber = await nextNumber('invoice');
      }
    }
    if (body.orderNumber) await bumpCounterTo('invoice', body.orderNumber);

    // Log notable changes as activity events (status, paid).
    const newEvents = [];
    if (body.status !== undefined && body.status !== current.status) {
      newEvents.push({
        kind: 'status_changed', actor: 'admin',
        message: `Status: ${current.status} → ${body.status}`,
        meta: { from: current.status, to: body.status },
        at: new Date(),
      });
    }
    if (body.paid !== undefined && body.paid !== current.paid) {
      newEvents.push({
        kind: 'paid_changed', actor: 'admin',
        message: body.paid ? 'Marked paid' : 'Marked unpaid',
        meta: { paid: body.paid },
        at: new Date(),
      });
    }

    const update = { $set: body };
    if (newEvents.length > 0) {
      update.$push = { activity: { $each: newEvents } };
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true },
    ).lean();
    if (!order) return res.status(404).json({ message: 'Not found' });
    // Auto-promote to customer ONLY on a real transition INTO a placed status
    // (prior status was not placed). Best-effort — never blocks the response.
    if (isPlacedStatus(order.status) && !isPlacedStatus(current.status)) {
      await bumpCustomerOnPlacement(order);
    }
    res.json(order);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

// DELETE /api/orders/:id — SOFT delete (archive). A fat-finger "delete" used to
// hard-destroy the whole project (quote lines, confirmation, approval token,
// activity, file metadata) while its Transactions kept pointing at a now-dangling
// orderNumber — the exact archive-not-delete rule the model already supports and
// the owner already flagged on the Vendors PO delete. Archived orders drop out of
// every working surface (list/dashboard already filter them) but stay recoverable.
const deleteOrder = async (req, res) => {
  try {
    await Order.updateOne(
      { _id: req.params.id },
      { $set: { archived: true, archivedAt: new Date(), archivedReason: 'manual' } },
    );
    // Its POs must not linger as live rows pointing at an archived order (they'd
    // keep counting on vendor cards and in PO lists). Soft-archive them too, so an
    // unarchive of the order can restore both.
    await PurchaseOrder.updateMany(
      { orderId: req.params.id, archived: { $ne: true } },
      { $set: { archived: true, archivedAt: new Date(), archivedReason: 'order-deleted' } },
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/dashboard — light stats used by the header strip on the new UI.
const dashboard = async (req, res) => {
  try {
    const now = new Date();
    const startOfYear  = new Date(now.getFullYear(), 0, 1);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [stats] = await Order.aggregate([
      // Archived (soft-deleted / reverted) orders must not count toward revenue,
      // open-order, or unpaid totals — they're gone from the working view.
      { $match: { archived: { $ne: true } } },
      { $group: {
        _id: null,
        revenueAllTime: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$totalValue', 0] } },
        revenueThisYear: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'delivered'] }, { $gte: [{ $ifNull: ['$deliveredDate', '$orderDate'] }, startOfYear] }] }, '$totalValue', 0] } },
        revenueThisMonth: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'delivered'] }, { $gte: [{ $ifNull: ['$deliveredDate', '$orderDate'] }, startOfMonth] }] }, '$totalValue', 0] } },
        openOrders: { $sum: { $cond: [{ $in: ['$status', ['approved', 'placed', 'in_production', 'shipped']] }, 1, 0] } },
        openQuotes: { $sum: { $cond: [{ $eq: ['$status', 'quoted'] }, 1, 0] } },
        unpaidTotal: { $sum: { $cond: [{ $and: [{ $eq: ['$paid', false] }, { $ne: ['$status', 'quoted'] }, { $ne: ['$status', 'cancelled'] }] }, '$totalValue', 0] } },
      }},
    ]);

    res.json({
      revenueAllTime:   (stats && stats.revenueAllTime)   || 0,
      revenueThisYear:  (stats && stats.revenueThisYear)  || 0,
      revenueThisMonth: (stats && stats.revenueThisMonth) || 0,
      openOrders:       (stats && stats.openOrders)       || 0,
      openQuotes:       (stats && stats.openQuotes)       || 0,
      unpaidTotal:      (stats && stats.unpaidTotal)      || 0,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/attention — the hub command-center "what needs attention" feed:
// OPEN orders aged past the owner's turnaround. He places an order and expects
// 2–3 weeks; flag "running long" at 2 weeks and "possibly late" at 3. The clock
// starts the day it's PLACED, so age is anchored to the status_changed→placed
// event when present, then orderDate, then createdAt — measured in whole ET
// CALENDAR days (etDayKey of the placement vs etToday) so a late-evening placement
// is never off by one. 'approved' is excluded: turnaround starts at placement, not
// quote approval.
const ATTENTION_OPEN_STATUSES = ['placed', 'in_production', 'shipped'];
const orderPlacedAt = (o) => {
  const ev = (Array.isArray(o.activity) ? o.activity : [])
    .filter((e) => e && e.kind === 'status_changed' && e.meta && e.meta.to === 'placed')
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))[0];
  return (ev && ev.at) || o.orderDate || o.createdAt || null;
};
const etAgeDays = (placedAt, now = new Date()) => {
  const pk = etDayKey(placedAt);
  if (!pk) return null;
  const today = Date.parse(`${etToday(now)}T00:00:00Z`);
  const placed = Date.parse(`${pk}T00:00:00Z`);
  if (Number.isNaN(today) || Number.isNaN(placed)) return null;
  return Math.round((today - placed) / 86400000);
};
const attention = async (req, res) => {
  try {
    const open = await Order.find({ status: { $in: ATTENTION_OPEN_STATUSES }, archived: { $ne: true } })
      .select('projectNumber orderNumber companyName clientName status orderDate createdAt activity totalValue')
      .lean();
    const orders = [];
    for (const o of open) {
      const placedAt = orderPlacedAt(o);
      const ageDays = etAgeDays(placedAt);
      if (ageDays == null) continue;
      const flag = ageDays >= 21 ? 'possibly_late' : ageDays >= 14 ? 'running_long' : null;
      if (!flag) continue;
      orders.push({
        _id: String(o._id),
        projectNumber: o.projectNumber || '',
        orderNumber: o.orderNumber || '',
        companyName: o.companyName || '',
        clientName: o.clientName || '',
        status: o.status,
        ageDays, placedAt, flag,
      });
    }
    orders.sort((a, b) => b.ageDays - a.ageDays);   // oldest (most at-risk) first
    res.json({
      orders,
      counts: {
        possibly_late: orders.filter((o) => o.flag === 'possibly_late').length,
        running_long: orders.filter((o) => o.flag === 'running_long').length,
      },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
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
      { $push: {
        files: meta,
        activity: { kind: 'file_uploaded', actor: 'admin', message: `Uploaded ${meta.originalName}`, meta: { filename: meta.filename }, at: new Date() },
      }},
      { new: true },
    ).lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(meta);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Resolve an uploaded file safely: the name must be a plain basename (no
// path segments — Express decodes %2e%2e%2f after routing) AND belong to
// this order's files[]. Returns the absolute path or null.
async function _resolveOrderFile(orderId, rawName) {
  const path = require('path');
  const name = String(rawName || '');
  if (!name || name !== path.basename(name)) return null;
  const order = await Order.findById(orderId).select('files').lean();
  const owned = order && (order.files || []).some(f => f.filename === name);
  if (!owned) return null;
  return path.join(__dirname, '..', 'uploads', name);
}

// DELETE /api/orders/:id/files/:filename
const deleteFile = async (req, res) => {
  try {
    const fs = require('fs');
    const filepath = await _resolveOrderFile(req.params.id, req.params.filename);
    if (!filepath) return res.status(404).json({ message: 'File not found on this order.' });
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
    const filepath = await _resolveOrderFile(req.params.id, req.params.filename);
    if (!filepath) return res.status(404).json({ message: 'File not found on this order.' });
    res.sendFile(filepath);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/clients-summary — one row per unique company. Used by the
// new Clients overview dialog.
const clientsSummary = async (req, res) => {
  try {
    const orders = await Order.find({}).select('status totalValue companyName clientName companyKey updatedAt orderDate paid').lean();

    const byKey = {};
    orders.forEach(o => {
      const key = o.companyKey || (o.companyName || o.clientName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!key) return;
      if (!byKey[key]) {
        byKey[key] = {
          companyKey: key,
          companyName: o.companyName || '',
          clientName:  o.clientName  || '',
          projectCount: 0,
          deliveredCount: 0,
          deliveredRevenue: 0,
          openValue: 0,
          unpaidValue: 0,
          lastActivity: null,
          statuses: {},
        };
      }
      const c = byKey[key];
      c.projectCount++;
      c.statuses[o.status] = (c.statuses[o.status] || 0) + 1;
      if (o.status === 'delivered') {
        c.deliveredCount++;
        c.deliveredRevenue += Number(o.totalValue) || 0;
      }
      if (['approved', 'placed', 'in_production', 'shipped'].includes(o.status)) {
        c.openValue += Number(o.totalValue) || 0;
        if (!o.paid) c.unpaidValue += Number(o.totalValue) || 0;
      }
      const when = o.updatedAt || o.orderDate;
      if (when && (!c.lastActivity || new Date(when) > new Date(c.lastActivity))) {
        c.lastActivity = when;
      }
      // Keep richer name if any project has it
      if (!c.companyName && o.companyName) c.companyName = o.companyName;
      if (!c.clientName  && o.clientName)  c.clientName  = o.clientName;
    });

    const clients = Object.values(byKey).sort((a, b) =>
      new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime());
    res.json({ clients });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/analytics — single-roundtrip analytics for the dashboard
// view: revenue by month, top clients, top garment styles, margin breakdown.
const analytics = async (req, res) => {
  try {
    const now = new Date();
    const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);

    const orders = await Order.find({}).select('status totalValue cogs orderDate companyName clientName companyKey quoteLines').lean();

    // Revenue by month (delivered only, last 12 months)
    const monthBuckets = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthBuckets[k] = { month: k, revenue: 0, orders: 0, cogs: 0 };
    }
    orders.forEach(o => {
      if (o.status !== 'delivered' || !o.orderDate) return;
      const d = new Date(o.orderDate);
      if (d < oneYearAgo) return;
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthBuckets[k]) return;
      monthBuckets[k].revenue += Number(o.totalValue) || 0;
      monthBuckets[k].cogs    += Number(o.cogs) || 0;
      monthBuckets[k].orders  += 1;
    });
    const revenueByMonth = Object.values(monthBuckets);

    // Top clients (delivered revenue)
    const byClient = {};
    orders.forEach(o => {
      if (o.status !== 'delivered') return;
      const key = o.companyKey || (o.companyName || o.clientName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!key) return;
      if (!byClient[key]) byClient[key] = { companyKey: key, companyName: o.companyName, clientName: o.clientName, revenue: 0, orders: 0 };
      byClient[key].revenue += Number(o.totalValue) || 0;
      byClient[key].orders  += 1;
    });
    const topClients = Object.values(byClient).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    // Top garment styles (qty across all quoteLines)
    const byStyle = {};
    orders.forEach(o => {
      (o.quoteLines || []).forEach(l => {
        const code = (l.styleCode || '').trim();
        if (!code) return;
        if (!byStyle[code]) byStyle[code] = { styleCode: code, qty: 0, lineCount: 0, sample: l.description };
        byStyle[code].qty       += Number(l.qty) || 0;
        byStyle[code].lineCount += 1;
      });
    });
    const topStyles = Object.values(byStyle).sort((a, b) => b.qty - a.qty).slice(0, 10);

    // Overall margin (delivered only)
    let totalRevenue = 0, totalCogs = 0;
    orders.forEach(o => {
      if (o.status !== 'delivered') return;
      totalRevenue += Number(o.totalValue) || 0;
      totalCogs    += Number(o.cogs) || 0;
    });
    const overallMargin    = totalRevenue - totalCogs;
    const overallMarginPct = totalRevenue > 0 ? (overallMargin / totalRevenue) * 100 : 0;

    res.json({
      revenueByMonth, topClients, topStyles,
      overall: { revenue: totalRevenue, cogs: totalCogs, margin: overallMargin, marginPct: overallMarginPct },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/cleanup-candidates — surfaces stuff that's safe to clean:
// - empty projects (no client/company, no items, no quote, no mockup, no $)
// - company-name collisions (different companyName strings resolving to the
//   same companyKey — usually typos like "Bract House" vs "Bract House Inc")
const cleanupCandidates = async (req, res) => {
  try {
    const orders = await Order.find({}).select(
      'projectNumber orderNumber companyName clientName companyKey ' +
      'totalValue items quoteLines mockupNumbers files status createdAt'
    ).lean();

    const empty = orders.filter(o =>
      !o.companyName && !o.clientName &&
      !(o.items || []).length &&
      !(o.quoteLines || []).length &&
      !(o.mockupNumbers || []).length &&
      !(o.files || []).length &&
      (!o.totalValue || o.totalValue === 0) &&
      !o.orderNumber
    );

    // Group by companyKey, flag keys with >1 distinct companyName
    const byKey = {};
    orders.forEach(o => {
      const k = o.companyKey || '';
      if (!k) return;
      if (!byKey[k]) byKey[k] = { companyKey: k, variants: new Map(), projectCount: 0 };
      const name = o.companyName || o.clientName || '';
      const cur = byKey[k].variants.get(name) || 0;
      byKey[k].variants.set(name, cur + 1);
      byKey[k].projectCount++;
    });
    const nameCollisions = Object.values(byKey)
      .filter(g => g.variants.size > 1)
      .map(g => ({
        companyKey: g.companyKey,
        projectCount: g.projectCount,
        variants: [...g.variants.entries()].map(([name, count]) => ({ name, count })),
      }));

    res.json({
      empty: empty.map(o => ({
        _id: o._id, projectNumber: o.projectNumber, createdAt: o.createdAt, status: o.status,
      })),
      nameCollisions,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/cleanup-delete — bulk-delete by ids
const cleanupDelete = async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.json({ deleted: 0 });
    const result = await Order.deleteMany({ _id: { $in: ids } });
    res.json({ deleted: result.deletedCount });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/merge-company — renames every order matching `from` to use
// the canonical `to` companyName. companyKey is re-derived by the pre-save hook
// via findOneAndUpdate, so this is also the path to dedupe variants. Also
// re-points any ClientLogo + StudioLibraryItem record so logos / mockups follow.
const mergeCompany = async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ message: 'from and to are required' });
    if (from === to) return res.json({ ordersUpdated: 0, mockupsUpdated: 0, logosMerged: 0 });

    const ordersResult = await Order.updateMany(
      { $or: [{ companyName: from }, { clientName: from }] },
      { $set: { companyName: to, companyKey: deriveCompanyKey(to, '') } },
    );
    const mockupsResult = await StudioLibraryItem.updateMany(
      { store: 'mockups', client: from },
      { $set: { client: to } },
    );

    // Consolidate logos: if 'from' has a logo and 'to' doesn't, move it; else
    // drop the 'from' logo so it can't shadow the 'to' logo by companyKey.
    const fromKey = deriveCompanyKey(from, '');
    const toKey   = deriveCompanyKey(to, '');
    const ClientLogo = require('../models/ClientLogo');
    let logosMerged = 0;
    if (fromKey && fromKey !== toKey) {
      const [fromLogo, toLogo] = await Promise.all([
        ClientLogo.findOne({ companyKey: fromKey }),
        ClientLogo.findOne({ companyKey: toKey }),
      ]);
      if (fromLogo && !toLogo) {
        await ClientLogo.create({ companyKey: toKey, companyName: to,
          imageDataUrl: fromLogo.imageDataUrl, uploadedAt: new Date() });
        logosMerged = 1;
      }
      if (fromLogo) {
        await ClientLogo.deleteOne({ companyKey: fromKey });
      }
    }

    res.json({
      ordersUpdated:  ordersResult.modifiedCount,
      mockupsUpdated: mockupsResult.modifiedCount,
      logosMerged,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/:id/duplicate — clones a project. Use cases:
// - Re-order: same artwork, new run
// - Template: starting point for a similar request
// Carries over: company, client, items, quoteLines, supplier, printer, markup
// fields, confirmation message + terms, mockupNumbers.
// Resets: orderNumber, status='quoted', orderDate/shipDate/deliveredDate=null,
// paid=false, files=[], approvalToken='', approvalEvents=[]. Auto-assigns the
// next projectNumber.
const duplicateOrder = async (req, res) => {
  try {
    const src = await Order.findById(req.params.id).lean();
    if (!src) return res.status(404).json({ message: 'Project not found' });

    const fresh = {
      projectNumber:       await nextNumber('project'),
      orderNumber:         '',
      clientName:          src.clientName  || '',
      companyName:         src.companyName || '',
      status:              'quoted',
      paid:                false,
      totalValue:          src.totalValue,
      cogs:                src.cogs,
      printerName:         src.printerName || '',
      supplier:            src.supplier    || '',
      notes:               src.notes       || '',
      confirmationMessage: src.confirmationMessage || '',
      confirmationTerms:   src.confirmationTerms   || '',
      mockupNumbers:       Array.isArray(req.body && req.body.carryMockups) ? src.mockupNumbers : [],
      items:               (src.items || []).map(i => ({ description: i.description, qty: i.qty, unitPrice: i.unitPrice })),
      quoteLines:          (src.quoteLines || []).map(l => ({
        qty: l.qty, styleCode: l.styleCode, description: l.description, color: l.color,
        supplier: l.supplier, blankCost: l.blankCost,
        printType: l.printType, printDetails: l.printDetails, printCost: l.printCost,
        setupCost: l.setupCost, shippingCost: l.shippingCost,
        markup: l.markup, unitPrice: l.unitPrice, turnaroundWeeks: l.turnaroundWeeks,
      })),
      orderDate:     null,
      shipDate:      null,
      deliveredDate: null,
      importedFrom:  `duplicate:${src.projectNumber || src._id}`,
      activity: [{
        kind: 'duplicated_from', actor: 'admin',
        message: `Cloned from project #${src.projectNumber || src._id}`,
        meta: { sourceProjectNumber: src.projectNumber, sourceProjectId: String(src._id), carryMockups: !!(req.body && req.body.carryMockups) },
        at: new Date(),
      }],
    };

    const created = await Order.create(fresh);
    res.status(201).json(created);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/from-submission/:submissionId — manual inquiry → project bridge.
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
      projectNumber:       await nextNumber('project'),
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

// A project counts as LIVE (reusable) for a company when it's neither archived
// nor in a terminal state -- i.e. still somewhere in the active lifecycle the
// owner would keep quoting/mocking against. 'delivered' is the won/completed end
// state and 'cancelled' is dead; both mean "start a fresh project for new work",
// so they're excluded. Pure (no DB) so the create-or-get idempotency is unit-
// testable directly from a list of order POJOs. Among live candidates we keep the
// one earliest in the lifecycle (lowest status rank), tie-broken by most-recent,
// so a re-entry lands on the project the owner is actually working -- not a random
// sibling. Returns the chosen order, or null when there's nothing live to reuse.
const PROJECT_LIFECYCLE_RANK = {
  quoted: 0, approved: 1, placed: 2, in_production: 3, shipped: 4, delivered: 5, cancelled: 6,
};
const LIVE_TERMINAL_STATUSES = ['delivered', 'cancelled'];
function isLiveProject(o) {
  if (!o) return false;
  if (o.archived === true) return false;
  return !LIVE_TERMINAL_STATUSES.includes(o.status);
}
function pickLiveProjectForCompany(orders) {
  const live = (Array.isArray(orders) ? orders : []).filter(isLiveProject);
  if (live.length === 0) return null;
  return live.slice().sort((a, b) => {
    const ar = PROJECT_LIFECYCLE_RANK[a.status] != null ? PROJECT_LIFECYCLE_RANK[a.status] : 0;
    const br = PROJECT_LIFECYCLE_RANK[b.status] != null ? PROJECT_LIFECYCLE_RANK[b.status] : 0;
    if (ar !== br) return ar - br;                       // earliest lifecycle first
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0); // then newest
  })[0];
}

// POST /api/orders/for-company -- create-or-get the working project for a CRM
// company entering the "quoting" stage. This is the LEAD -> QUOTE -> ORDERS
// handoff: a deal only gets a project # once the owner moves it to quoting.
// IDEMPOTENT -- if a live (non-delivered/non-cancelled, non-archived) project
// already exists for the company it's returned as-is (never a second project #);
// otherwise a fresh project is created with the next project # via the SAME
// nextNumber('project') sequence + companyKey linkage the rest of the app uses.
// Best-effort by contract: the CRM stage write that triggers this must never fail
// because the order create hiccups, so the caller (frontend) treats any failure
// as a soft miss. Body: { companyKey?, companyName?, clientName?, dealValue?,
// contactName?, contactEmail?, contactPhone? }. companyKey is honored when sent;
// otherwise derived from the names exactly like Order.companyKey, so the link
// matches everywhere.
const createOrGetProjectForCompany = async (req, res) => {
  try {
    const body = req.body || {};
    const companyName = (body.companyName || '').toString().trim();
    const clientName  = (body.clientName  || '').toString().trim();
    const bodyKey = (body.companyKey || '').toString().trim();
    // The Order model ALWAYS keys an order by deriveCompanyKey(names) (pre-save
    // hook), so that's the key the project will actually carry. Key the CRM
    // 'quoting' card and the reuse lookup off that SAME derived key so the project
    // and its CRM record can never orphan (and the idempotent reuse query finds
    // the company's existing orders — which are stored under the derived key too,
    // NOT necessarily the frozen Client identity key the caller passed). Fall back
    // to an explicit companyKey only when there are no names to derive from.
    const key = deriveCompanyKey(companyName, clientName) || bodyKey;
    if (!key) return res.status(400).json({ message: 'companyKey (or a company/client name) is required' });

    // Ensure the company is also a first-class CRM record at the 'quoting' stage,
    // so the order-centric pipeline board (and Companies / Today) shows it the
    // moment it's quoting — not just once some other path creates a Client row.
    // Best-effort + idempotent + UP-only (never regresses an owner-advanced or
    // closed stage); a CRM hiccup must never block minting the project.
    try {
      await ensureCompanyForQuoting(key, { companyName, clientName, dealValue: Number(body.dealValue) || 0 });
    } catch (e) {
      console.warn('[orders] ensureCompanyForQuoting skipped:', e.message);
    }

    // Reuse an existing live project for this company -> idempotent re-entry.
    // Match the canonical (derived) key OR the caller's passed key, so a project
    // stored under either is reused rather than duplicated — including ones minted
    // before this reconciliation. Pick the one to work WITHOUT minting a new number.
    const reuseKeys = [...new Set([key, bodyKey].filter(Boolean))];
    const existingOrders = await Order.find({ companyKey: { $in: reuseKeys } }).lean();
    const reuse = pickLiveProjectForCompany(existingOrders);
    if (reuse) return res.json({ order: reuse, created: false });

    // Nothing live -> create the project. Mirrors createFromSubmission: next
    // project # from the shared sequence, status starts at 'quoted', carry the
    // deal's contact + value so the order page opens pre-seeded. companyKey is
    // recomputed by the model's pre-save hook from the names, so we pass names.
    const dealValue = Number(body.dealValue) || 0;
    const contactBits = [
      body.contactName  && `Contact: ${body.contactName}`,
      body.contactEmail && `Email: ${body.contactEmail}`,
      body.contactPhone && `Phone: ${body.contactPhone}`,
      dealValue > 0     && `Estimated deal value: $${dealValue.toLocaleString('en-US')}`,
    ].filter(Boolean).join('\n');

    const projectNumber = await nextNumber('project');
    const order = await Order.create({
      projectNumber,
      companyName,
      clientName: clientName || body.contactName || '',
      status:     'quoted',
      // Seed the quote total from the deal value so the project isn't $0 before a
      // quote is built; it's overwritten the moment a real quote/confirmation is
      // saved (computeQuoteTotals / computeConfirmationTotals own totalValue then).
      totalValue: dealValue,
      notes:      contactBits,
      importedFrom: 'crm-quoting',
      activity: [{
        kind: 'created', actor: 'admin',
        message: `Project #${projectNumber} created from CRM (moved to quoting)`,
        at: new Date(),
      }],
    });
    return res.status(201).json({ order: order.toObject(), created: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/mockup-health — diagnostic report: which project mockup #s
// are backed by a Studio library item, which aren't, and which library items
// don't belong to any project. Used by the Order Tracker "Mockup health"
// button so the user can see the real state of mockup linking at a glance.
const mockupHealth = async (req, res) => {
  try {
    const norm = (n) => String(n || '').replace(/^#/, '').replace(/^0+/, '').toUpperCase();

    const [projects, library] = await Promise.all([
      Order.find({}).select('projectNumber orderNumber companyName clientName mockupNumbers').lean(),
      StudioLibraryItem.find({ store: 'mockups' })
        .select('name client pageState.mockupNum thumbnail savedAt')
        .lean(),
    ]);

    // Build a lookup: normalized mockup# → library item
    const libByNorm = {};
    library.forEach(m => {
      const k = norm(m.pageState && m.pageState.mockupNum);
      if (k) libByNorm[k] = m;
    });

    // For each project, classify its mockup #s as matched or missing
    const matched = [];        // { projectNumber, companyName, mockupNum, item: { _id, name } }
    const missing = [];        // { projectNumber, companyName, mockupNum }
    projects.forEach(p => {
      (p.mockupNumbers || []).forEach(num => {
        const item = libByNorm[norm(num)];
        if (item) {
          matched.push({
            projectNumber: p.projectNumber, orderNumber: p.orderNumber,
            companyName: p.companyName, clientName: p.clientName,
            mockupNum: num,
            itemId: item._id, itemName: item.name,
          });
        } else {
          missing.push({
            projectNumber: p.projectNumber, orderNumber: p.orderNumber,
            companyName: p.companyName, clientName: p.clientName,
            mockupNum: num,
          });
        }
      });
    });

    // Set of normalized mockup #s referenced by any project
    const referencedNorms = new Set();
    projects.forEach(p => (p.mockupNumbers || []).forEach(n => referencedNorms.add(norm(n))));

    // Auto-match orphans by client slug so the report reflects what the
    // OrderTracker drawer actually displays (green AUTO tiles). A library
    // item whose mockup# isn't linked but whose client name slug-matches a
    // project is classified as "autoMatched", not "orphan".
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const projectSlugIndex = {};
    projects.forEach(p => {
      [p.companyName, p.clientName].forEach(raw => {
        const k = slug(raw);
        if (k) projectSlugIndex[k] = projectSlugIndex[k] || p;
      });
    });
    const findProjectFor = (libItem) => {
      const titleClient = String(libItem.name || '').replace(/\s+merch\s*$/i, '').trim();
      const candidates = [
        slug(libItem.client || (libItem.pageState && libItem.pageState.client) || ''),
        slug(titleClient),
      ].filter(Boolean);
      // Exact slug
      for (const k of candidates) if (projectSlugIndex[k]) return projectSlugIndex[k];
      // Fuzzy: prefix / substring (min 4 chars on both sides)
      for (const k of candidates) {
        if (k.length < 4) continue;
        for (const pk of Object.keys(projectSlugIndex)) {
          if (pk.length < 4) continue;
          if (pk.startsWith(k) || k.startsWith(pk) || pk.includes(k) || k.includes(pk)) {
            return projectSlugIndex[pk];
          }
        }
      }
      return null;
    };

    const orphans = [];
    const autoMatched = [];
    for (const m of library) {
      const k = norm(m.pageState && m.pageState.mockupNum);
      if (k && referencedNorms.has(k)) continue;          // already linked
      const proj = findProjectFor(m);
      const entry = {
        _id: m._id, name: m.name, client: m.client,
        mockupNum: (m.pageState && m.pageState.mockupNum) || '',
        savedAt: m.savedAt,
      };
      if (proj) {
        autoMatched.push({ ...entry, projectNumber: proj.projectNumber, companyName: proj.companyName });
      } else {
        orphans.push(entry);
      }
    }

    res.json({
      summary: {
        projects:           projects.length,
        libraryItems:       library.length,
        projectMockupRefs:  matched.length + missing.length,
        linked:             matched.length,
        autoMatched:        autoMatched.length,
        missing:            missing.length,
        orphans:            orphans.length,
      },
      matched, autoMatched, missing, orphans,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/mockups/auto-link  { commit?: boolean }
// Links orphan jpstudio mockups (saved before the Project dropdown existed) to
// their projects. Two signals, in priority order:
//   1. base number — every project gets its own batch number, so #000061A..D
//      all belong to one project. An orphan #000061E links to whatever project
//      already references #000061*.
//   2. company name — the library item's name/client text contains a project's
//      companyKey (e.g. "Bleu Leaf Dispensary Merch" → bleuleafdispensary).
// Without commit:true this is a dry run and only returns the proposed links.
const autoLinkMockups = async (req, res) => {
  try {
    const commit = !!(req.body && req.body.commit);
    const norm   = (n) => String(n || '').replace(/^#/, '').replace(/^0+/, '').toUpperCase();
    const baseOf = (n) => { const m = norm(n).match(/^(\d+)/); return m ? m[1] : ''; };
    const slug   = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

    const [projects, library] = await Promise.all([
      Order.find({}).select('projectNumber companyName clientName companyKey mockupNumbers status updatedAt').lean(),
      StudioLibraryItem.find({ store: 'mockups' }).select('name client pageState.mockupNum').lean(),
    ]);

    // Active = anything still in flight; the current project for a recurring
    // client. Closed orders shouldn't soak up new mockups.
    const isClosed = (p) => p.status === 'delivered' || p.status === 'cancelled';
    const isActive = (p) => !isClosed(p);

    // Sort active-then-closed, then newest projectNumber first, so when
    // multiple projects share a company we always pick the current one.
    const rankProjects = (arr) => arr.slice().sort((a, b) => {
      const ac = isClosed(a) ? 1 : 0, bc = isClosed(b) ? 1 : 0;
      if (ac !== bc) return ac - bc;
      const an = parseInt(String(a.projectNumber || '0').match(/\d+/)?.[0] || '0', 10);
      const bn = parseInt(String(b.projectNumber || '0').match(/\d+/)?.[0] || '0', 10);
      return bn - an;
    });

    // Index projects: every mockup# already referenced (active OR closed), and
    // projects by base #. The earlier "active-only" rule was too clever — it
    // tried to let stale links migrate from a closed order to the new active
    // one, but it also meant any mockup linked to a closed project showed up
    // as orphan FOREVER. Each auto-link run would re-link the same 10 mockups
    // to the same closed project, and they'd stay in the "to link" bucket on
    // the next scan. Now: once a mockup is in ANY project's mockupNumbers,
    // it's treated as linked. Stale-link migration is a separate concern handled
    // by the project drawer's auto-cleanup pass.
    const referencedNorms = new Set();
    const projectsByBase  = {};
    projects.forEach(p => {
      (p.mockupNumbers || []).forEach(n => {
        const nn = norm(n);
        if (nn) referencedNorms.add(nn);
        const b = baseOf(n);
        if (b) {
          if (!projectsByBase[b]) projectsByBase[b] = [];
          if (!projectsByBase[b].some(x => String(x._id) === String(p._id))) projectsByBase[b].push(p);
        }
      });
    });
    const companyKeys = [...new Set(projects.map(p => p.companyKey).filter(k => k && k.length >= 4))];

    const links = [], ambiguous = [], unmatched = [];
    let alreadyLinked = 0;

    for (const item of library) {
      const rawNum = (item.pageState && item.pageState.mockupNum) || '';
      const nn = norm(rawNum);
      if (!nn) { unmatched.push({ itemId: item._id, itemName: item.name || '', mockupNum: rawNum, reason: 'no mockup #' }); continue; }
      if (referencedNorms.has(nn)) { alreadyLinked++; continue; }

      const base = baseOf(rawNum);
      const baseHits = rankProjects((base && projectsByBase[base]) || []);
      let target = null, via = null;

      // Prefer the highest-ranked (active, newest) project even if multiple
      // share the base. If the only matches are closed projects, fall back
      // to the most recent of those — better than nothing.
      const activeBaseHits = baseHits.filter(isActive);
      if (activeBaseHits.length >= 1) {
        target = activeBaseHits[0]; via = 'base';
      } else if (baseHits.length >= 1) {
        target = baseHits[0]; via = 'base';
      }

      if (!target) {
        const itemSlug = slug(`${item.name || ''} ${item.client || ''}`);
        let bestKey = '';
        companyKeys.forEach(k => { if (itemSlug.includes(k) && k.length > bestKey.length) bestKey = k; });
        if (bestKey) {
          const nameHits = rankProjects(projects.filter(p => p.companyKey === bestKey));
          const activeNameHits = nameHits.filter(isActive);
          if (activeNameHits.length >= 1) {
            target = activeNameHits[0]; via = 'name';
          } else if (nameHits.length === 1) {
            target = nameHits[0]; via = 'name';
          } else if (nameHits.length > 1) {
            // Multiple closed-only matches with no active. Genuinely ambiguous.
            ambiguous.push({ itemId: item._id, itemName: item.name || '', mockupNum: rawNum,
              candidates: nameHits.map(p => ({ projectNumber: p.projectNumber, companyName: p.companyName || p.clientName || '' })) });
            continue;
          }
        }
      }

      if (!target) { unmatched.push({ itemId: item._id, itemName: item.name || '', mockupNum: rawNum, reason: 'no match' }); continue; }

      links.push({
        itemId: item._id, itemName: item.name || '', mockupNum: rawNum,
        projectId: target._id, projectNumber: target.projectNumber,
        projectCompany: target.companyName || target.clientName || '', via,
      });
    }

    let projectsAffected = 0, mockupsLinked = 0;
    if (commit && links.length) {
      const byProject = {};
      links.forEach(l => {
        const k = String(l.projectId);
        if (!byProject[k]) byProject[k] = { projectId: l.projectId, nums: [] };
        if (!byProject[k].nums.includes(l.mockupNum)) byProject[k].nums.push(l.mockupNum);
      });
      for (const grp of Object.values(byProject)) {
        await Order.updateOne(
          { _id: grp.projectId },
          {
            $addToSet: { mockupNumbers: { $each: grp.nums } },
            $push: { activity: {
              kind: 'mockups_linked', actor: 'system',
              message: `Auto-linked ${grp.nums.length} mockup${grp.nums.length === 1 ? '' : 's'}: ${grp.nums.join(', ')}`,
              meta: { mockupNumbers: grp.nums, source: 'auto-link' },
              at: new Date(),
            } },
          },
        );
        projectsAffected++;
        mockupsLinked += grp.nums.length;
      }
    }

    res.json({
      committed: commit,
      summary: {
        libraryMockups:   library.length,
        alreadyLinked,
        proposed:         links.length,
        byBase:           links.filter(l => l.via === 'base').length,
        byName:           links.filter(l => l.via === 'name').length,
        ambiguous:        ambiguous.length,
        unmatched:        unmatched.length,
        projectsAffected: commit ? projectsAffected : new Set(links.map(l => String(l.projectId))).size,
        mockupsLinked:    commit ? mockupsLinked : links.length,
      },
      links, ambiguous, unmatched,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Excel-style letter sequence: A…Z, AA, AB, … so the series never dead-ends.
// (The old single-letter regex made everything after the 26th mockup collide
// on "AA" forever — multi-letter suffixes were invisible to the max scan.)
function _letterToNum(s) {
  let n = 0;
  for (const c of s) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}
function _numToLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Compute the next consecutive mockup letter for a project, mirroring the
// studio's client-side _nextMockupNum so numbers stay consistent: base is
// "#" + projectNumber padded to 6 digits, then A, B, C, … Z, AA, AB, …
function _nextMockupLetter(projectNumber, existing) {
  const projNumRaw = String(projectNumber || '').split('-')[0];
  if (!projNumRaw) return '';
  const base = `#${projNumRaw.padStart(6, '0')}`;
  const nums = (existing || [])
    .filter(m => m && m.startsWith(base))
    .map(m => m.slice(base.length).toUpperCase())
    .filter(l => /^[A-Z]+$/.test(l))
    .map(_letterToNum);
  const max = nums.length ? Math.max(...nums) : 0;
  return `${base}${_numToLetter(max + 1)}`;
}

// POST /api/orders/:id/mockups/assign — atomically reserve the next mockup
// number (A, B, C…) for this project AND link it to the order in one step.
// This is the authoritative source for the lettering. The studio previously
// computed the letter client-side from a cached project list, which raced and
// produced duplicate "A"s — and once one mockup existed there was no way to add
// a second. Returns the assigned number, e.g. { mockupNum: "#000133B" }.
const assignMockupNumber = async (req, res) => {
  try {
    // Compute-then-claim with a conditional write: the push only succeeds if
    // nobody claimed the same letter between our read and write (the filter
    // excludes docs already containing it). The old $addToSet version silently
    // deduped, so two concurrent saves were BOTH told they owned the same
    // number. On a lost race, re-read and claim the next letter instead.
    for (let attempt = 0; attempt < 6; attempt++) {
      const order = await Order.findById(req.params.id).select('projectNumber mockupNumbers');
      if (!order) return res.status(404).json({ message: 'Project not found' });

      const next = _nextMockupLetter(order.projectNumber, order.mockupNumbers || []);
      if (!next) return res.status(400).json({ message: 'Project has no number to letter against.' });

      const r = await Order.updateOne(
        { _id: order._id, mockupNumbers: { $ne: next } },
        { $push: { mockupNumbers: next } },
      );
      if (r.modifiedCount === 1) {
        return res.json({ mockupNum: next, projectId: order._id });
      }
    }
    return res.status(409).json({ message: 'Could not reserve a mockup number — too many concurrent saves. Try again.' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  listOrders, listProjects, getOrder, createOrder, updateOrder, deleteOrder,
  seedHistorical, nextNumbers, uploadFile, deleteFile, serveFile,
  dashboard, attention, createFromSubmission, mockupHealth, duplicateOrder, analytics, clientsSummary,
  cleanupCandidates, cleanupDelete, mergeCompany, autoLinkMockups, assignMockupNumber,
  createOrGetProjectForCompany,
  // exported for tests / reuse
  isPlacedStatus, bumpCustomerOnPlacement, pickLiveProjectForCompany, isLiveProject,
  orderPlacedAt, etAgeDays,
};
