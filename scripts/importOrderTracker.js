// scripts/importOrderTracker.js
// One-time import of historical orders from the Google Drive Order Tracker.
// Run with: node scripts/importOrderTracker.js
require('dotenv').config();
const mongoose = require('mongoose');
const Order    = require('../models/Order');

const CLIENT_COMPANIES = {
  'Ryan Jotkoff':              'Jotkoff Financial Services',
  'Mike Woods':                'Electric Starship Arcade',
  'Rita Tsalyuk':              'Stadium Gardens',
  'Alex Gelman':               '',
  'Nicole Romero':             "Earl and Tom's",
  'Jocelyn Melo':              'Cannapi',
  'Daequan Langhorn':          'OS NYC',
  'Elizabeth Brockmann':       'Point in Time Studios',
  'Jill Cohen':                'The Cannaboss Lady',
  'Keegan Lapointe':           "Shaggy's Baggy",
  'Thomas Calmese':            'Green Gold',
  'Jason Grandizio':           'Sauce Me A Fry',
  'Shawn Hill / Amber Theurer': 'Human AF',
  "Ma'or Hemo":                '',
  'Logan Davis':               '',
  'Maji':                      'M4JI',
};

// Parse mockup number strings like "000005A+B", "41C,K,M,G", "21H", "55B,D"
function parseMockupNumbers(raw) {
  if (!raw || raw === 'N/A (Tekweld)' || raw === 'N/A (Cannabis Promotions)'
      || raw === 'N/A (RedTupid)' || raw === 'N/A' || raw === '') return [];
  const parts = raw.replace(/\s/g, '').split(/[+,]/);
  const firstPart = parts[0];
  const m = firstPart.match(/^(\d+)([A-Za-z]*)$/);
  if (!m) return [];
  const base = m[1].padStart(6, '0');
  const letters = [m[2], ...parts.slice(1)].filter(Boolean);
  return letters.map(l => `#${base}${l}`);
}

function parseDate(str) {
  if (!str || str === 'N/A' || str === '') return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/[$,]/g, '')) || 0;
}

function statusFromPaid(paidStr) {
  const s = (paidStr || '').toLowerCase();
  if (s === 'paid') return 'delivered';
  if (s === 'voided') return 'cancelled';
  if (s === 'unpaid') return 'approved';
  return 'placed';
}

const RAW_ORDERS = [
  { invoiceNum: '1001', orderNum: '0000001', clientName: 'Ryan Jotkoff',       items: '50 polos, pocket embroidery',               mockup: '000001B',           dateOfSale: '6/5/2024',   cogs: 844.21,  invoiced: 1682.86, paid: 'Paid',   printer: 'Apollo East'           },
  { invoiceNum: '1002', orderNum: '0000005', clientName: 'Mike Woods',          items: '100 shirts, chest screen print',             mockup: '000005A+B',         dateOfSale: '7/4/2024',   cogs: 776.58,  invoiced: 1338.87, paid: 'Paid',   printer: 'Apollo East'           },
  { invoiceNum: '1003', orderNum: '0000010', clientName: 'Ryan Jotkoff',       items: "24 women's polos, pocket embroidery",        mockup: '000010A',           dateOfSale: '9/12/2024',  cogs: 248.88,  invoiced: 416.49,  paid: 'Paid',   printer: 'Apollo East'           },
  { invoiceNum: '1004', orderNum: '0000020', clientName: 'Rita Tsalyuk',       items: '30,000 paper bags',                         mockup: '000019C',           dateOfSale: '10/31/2024', cogs: 3984.94, invoiced: 4545.00, paid: 'Paid',   printer: 'N/A'                   },
  { invoiceNum: '1005', orderNum: '0000021', clientName: 'Alex Gelman',        items: '500 toothbrushes',                          mockup: 'N/A (Tekweld)',     dateOfSale: '11/20/2024', cogs: 443.24,  invoiced: 841.69,  paid: 'Paid',   printer: 'Tekweld'               },
  { invoiceNum: '1009', orderNum: '0000024', clientName: 'Nicole Romero',      items: '250 glass pipes (chillums)',                 mockup: 'N/A (Cannabis Promotions)', dateOfSale: '', cogs: 362.93, invoiced: 551.00, paid: 'Voided',  printer: 'Cannabis Promotions'  },
  { invoiceNum: '1012', orderNum: '0000031', clientName: 'Jocelyn Melo',       items: '50 beanies embroidery + 50 hoodies screen print', mockup: '000024F+D+E+H+I', dateOfSale: '12/13/2024', cogs: 1454.79, invoiced: 1906.34, paid: 'Paid', printer: 'Apollo East'       },
  { invoiceNum: '1014', orderNum: '0000039', clientName: 'Daequan Langhorn',   items: '54 hoodies + long sleeves, screen print',   mockup: '000023A+B',         dateOfSale: '1/19/2025',  cogs: 942.78,  invoiced: 1117.14, paid: 'Paid',   printer: 'Apollo East'           },
  { invoiceNum: '1015', orderNum: '0000065', clientName: 'Elizabeth Brockmann', items: '20 shirts + 20 hats, screen print',        mockup: '000029D+E',         dateOfSale: '2/20/2025',  cogs: 716.58,  invoiced: 1065.53, paid: 'Paid',   printer: 'Ace Screen Printing'   },
  { invoiceNum: '1016', orderNum: '0000061', clientName: 'Jill Cohen',         items: '300 lighters + 2 buttermint cases',          mockup: 'N/A (Cannabis Promotions)', dateOfSale: '2/24/2025', cogs: 820.56, invoiced: 907.05, paid: 'Paid', printer: 'Cannabis Promotions' },
  { invoiceNum: '1018', orderNum: '0000022', clientName: 'Keegan Lapointe',    items: '300 lighters',                              mockup: 'N/A (Cannabis Promotions)', dateOfSale: '3/11/2025', cogs: 564.91, invoiced: 689.00, paid: 'Paid',  printer: 'Cannabis Promotions'  },
  { invoiceNum: '1020', orderNum: '0000022', clientName: 'Keegan Lapointe',    items: '30 hoodies',                                mockup: '000021H',           dateOfSale: '3/27/2025',  cogs: 846.58,  invoiced: 918.57,  paid: 'Paid',   printer: 'Ace Screen Printing'   },
  { invoiceNum: '1019', orderNum: '0000024', clientName: 'Nicole Romero',      items: '250 glass pipes (chillums)',                 mockup: 'N/A (Cannabis Promotions)', dateOfSale: '3/27/2025', cogs: 347.93, invoiced: 545.85, paid: 'Paid',  printer: 'Cannabis Promotions'  },
  { invoiceNum: '1021', orderNum: '0000030', clientName: 'Thomas Calmese',     items: '1,100 T-shirts',                            mockup: '000033L',           dateOfSale: '3/28/2025',  cogs: 7714.24, invoiced: 8321.39, paid: 'Paid',   printer: 'Ace Screen Printing'   },
  { invoiceNum: '1022', orderNum: '0000091', clientName: 'Jason Grandizio',    items: '100 T-shirts',                              mockup: '000040E+F',         dateOfSale: '5/14/2025',  cogs: 1191.48, invoiced: 1875.26, paid: 'Paid',   printer: 'Heritage Screen Printing' },
  { invoiceNum: '1023', orderNum: '0000083', clientName: 'Jill Cohen',         items: '200 T-shirts, 250 lip balm',                 mockup: '000041C,K,M,G',    dateOfSale: '5/30/2025',  cogs: 2466.04, invoiced: 3318.34, paid: 'Paid',   printer: 'Contract-DTG'          },
  { invoiceNum: '1025', orderNum: '0000093', clientName: 'Jill Cohen',         items: '250 totes, 600 Bic lighters',               mockup: '000043A,B',         dateOfSale: '6/30/2025',  cogs: 2194.98, invoiced: 2756.30, paid: 'Paid',   printer: 'Heritage Screen Printing' },
  { invoiceNum: '1023B', orderNum: '0000083', clientName: 'Jill Cohen',        items: '200 T-shirts, 250 lip balm (add-on)',        mockup: '000041C,K,M,G',    dateOfSale: '7/2/2025',   cogs: 107.55,  invoiced: 143.51,  paid: 'Paid',   printer: 'Contract-DTG'          },
  { invoiceNum: '1027', orderNum: '0000082', clientName: 'Daequan Langhorn',   items: '25 jerseys + 25 T-shirts',                  mockup: '000049A,B',         dateOfSale: '7/9/2025',   cogs: 698.93,  invoiced: 913.01,  paid: 'Paid',   printer: 'Heritage Screen Printing' },
  { invoiceNum: '1030', orderNum: '0000106', clientName: 'Shawn Hill / Amber Theurer', items: '1 hoodie + 1 hat',               mockup: '000055B,D',         dateOfSale: '9/17/2025',  cogs: 0,       invoiced: 218.53,  paid: 'Paid',   printer: 'Heritage Screen Printing' },
  { invoiceNum: '1029', orderNum: '0000107', clientName: 'Rita Tsalyuk',       items: '40,000 paper bags',                         mockup: '000056A',           dateOfSale: '9/17/2025',  cogs: 4758.14, invoiced: 5600.00, paid: 'Paid',   printer: 'N/A'                   },
  { invoiceNum: '1031', orderNum: '0000108', clientName: 'Alex Gelman',        items: '500 toothbrushes',                          mockup: 'N/A (Tekweld)',     dateOfSale: '10/1/2025',  cogs: 374.00,  invoiced: 642.41,  paid: 'Paid',   printer: 'Tekweld'               },
  { invoiceNum: '1032', orderNum: '0000109', clientName: "Ma'or Hemo",         items: '20 linen kippahs',                          mockup: 'N/A (RedTupid)',    dateOfSale: '11/3/2025',  cogs: 142.21,  invoiced: 180.65,  paid: 'Paid',   printer: 'RedTupid'              },
  { invoiceNum: '1034', orderNum: '0000112', clientName: 'Logan Davis',        items: 'Brand consulting',                          mockup: 'N/A',               dateOfSale: '12/3/2025',  cogs: 0,       invoiced: 4289.70, paid: 'Paid',   printer: 'N/A'                   },
  { invoiceNum: '1035', orderNum: '0000113', clientName: 'Logan Davis',        items: 'Brand consulting',                          mockup: 'N/A',               dateOfSale: '',           cogs: 0,       invoiced: 2101.00, paid: 'Unpaid', printer: 'N/A'                   },
  { invoiceNum: '1036', orderNum: '0000114', clientName: 'Jill Cohen',         items: '200 hoodies',                               mockup: '000062A,B,C,D,E,F,G,H', dateOfSale: '12/6/2025', cogs: 3262.08, invoiced: 4852.89, paid: '',     printer: 'Contract-DTG'          },
  { invoiceNum: 'UNK-111', orderNum: '0000111', clientName: 'Maji',            items: '25 hoodies + 25 T-shirts',                  mockup: '000060A+B',         dateOfSale: '',           cogs: 0,       invoiced: 1070.58, paid: '',       printer: ''                      },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  let created = 0;
  let skipped = 0;

  for (const raw of RAW_ORDERS) {
    // Check if this invoice already exists
    const exists = await Order.findOne({ orderNumber: raw.invoiceNum });
    if (exists) { console.log(`  Skip ${raw.invoiceNum} (already exists)`); skipped++; continue; }

    const companyName = CLIENT_COMPANIES[raw.clientName] ?? '';

    let statusStr = raw.paid;
    // Determine status
    let status;
    if (!statusStr) {
      status = raw.orderNum === '0000114' ? 'in_production' : 'placed';
    } else {
      status = statusFromPaid(statusStr);
    }

    const mockupNumbers = parseMockupNumbers(raw.mockup);

    const order = await Order.create({
      orderNumber:  raw.invoiceNum,
      clientName:   raw.clientName,
      companyName:  companyName,
      status,
      totalValue:   raw.invoiced,
      cogs:         raw.cogs,
      printerName:  raw.printer === 'N/A' ? '' : (raw.printer || ''),
      mockupNumbers,
      items: [{ description: raw.items, qty: 0, unitPrice: 0 }],
      orderDate:    parseDate(raw.dateOfSale),
      importedFrom: 'order_tracker',
    });

    console.log(`  Created order ${order.orderNumber} — ${raw.clientName} (${companyName || 'no company'})`);
    created++;
  }

  console.log(`\nDone. Created: ${created}, Skipped (already exist): ${skipped}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
