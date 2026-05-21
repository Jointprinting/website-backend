const Order = require('../models/Order');
const ContactSubmission = require('../models/ContactSubmission');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const { deriveCompanyKey } = require('../models/Order');

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
      const re = new RegExp(search.trim(), 'i');
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
    const orders = await Order.find({})
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

// POST /api/orders — create a new project. If projectNumber is not supplied,
// auto-assign the next one.
const createOrder = async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.projectNumber) {
      const all = await Order.find({}).select('projectNumber').lean();
      const max = all.reduce((m, o) => {
        const n = parseInt((o.projectNumber || '0').split('-')[0], 10) || 0;
        return Math.max(m, n);
      }, 0);
      body.projectNumber = String(max + 1);
    }
    const order = await Order.create(body);
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

    if (body.status === 'approved' || ['placed', 'in_production', 'shipped', 'delivered'].includes(body.status)) {
      const current = await Order.findById(req.params.id).select('orderNumber').lean();
      if (current && !current.orderNumber && !body.orderNumber) {
        const all = await Order.find({}).select('orderNumber').lean();
        const max = all.reduce((m, o) => {
          const n = parseInt(o.orderNumber || '0', 10) || 0;
          return Math.max(m, n);
        }, 0);
        body.orderNumber = String(max + 1);
      }
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { $set: body },
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

// GET /api/orders/dashboard — light stats used by the header strip on the new UI.
const dashboard = async (req, res) => {
  try {
    const now = new Date();
    const startOfYear  = new Date(now.getFullYear(), 0, 1);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [stats] = await Order.aggregate([
      { $group: {
        _id: null,
        revenueAllTime: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, '$totalValue', 0] } },
        revenueThisYear: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'delivered'] }, { $gte: ['$orderDate', startOfYear] }] }, '$totalValue', 0] } },
        revenueThisMonth: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'delivered'] }, { $gte: ['$orderDate', startOfMonth] }] }, '$totalValue', 0] } },
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

// POST /api/orders/from-submission/:submissionId — manual inquiry → project bridge.
const createFromSubmission = async (req, res) => {
  try {
    const sub = await ContactSubmission.findById(req.params.submissionId);
    if (!sub) return res.status(404).json({ message: 'Submission not found' });
    if (sub.orderId) {
      const existing = await Order.findById(sub.orderId).lean();
      if (existing) return res.json({ order: existing, alreadyLinked: true });
    }

    const all = await Order.find({}).select('projectNumber').lean();
    const max = all.reduce((m, o) => {
      const n = parseInt((o.projectNumber || '0').split('-')[0], 10) || 0;
      return Math.max(m, n);
    }, 0);

    const notes = [
      sub.notes && `Inquiry notes: ${sub.notes}`,
      sub.quantity && `Quantity: ${sub.quantity}`,
      sub.inHandDate && `In-hand by: ${sub.inHandDate}`,
      sub.shipToState && `Ship to: ${sub.shipToState}`,
    ].filter(Boolean).join('\n');

    const order = await Order.create({
      projectNumber:       String(max + 1),
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
  listOrders, listProjects, getOrder, createOrder, updateOrder, deleteOrder,
  seedHistorical, nextNumbers, uploadFile, deleteFile, serveFile,
  dashboard, createFromSubmission,
};
