// controllers/__tests__/poPdfBuffer.test.js
//   node --test controllers/__tests__/poPdfBuffer.test.js
// The PO PDF renderer, extracted to a Buffer so the download route AND the
// email-send flow produce the identical file.

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderPoPdfBuffer } = require('../purchaseOrders');

test('renderPoPdfBuffer returns a real PDF buffer for a full PO', async () => {
  const po = {
    poNumber: '#007', vendorName: 'Print Hybrid', contactName: 'Sean',
    vendorAddress: '405 E County Rd 7300, Lubbock, TX 79404',
    date: '2026-07-16', dueDate: '2026-07-30', blanksProvided: true,
    shipToPrinter: { name: 'Print Hybrid', streetAddress: '405 E County Rd 7300', cityStateZip: 'Lubbock, TX 79404' },
    shipping: { name: 'Client Co', streetAddress: '1 Main St', cityStateZip: 'Newark, NJ 07102' },
    items: [{ title: 'Gildan 5000 · Black', details: ['3c front', '1c back'] }],
    charges: [{ label: 'Print', amount: 250 }, { label: 'Shipping', amount: 20 }],
    grandTotal: 270, notes: 'Rush if possible.',
  };
  const buf = await renderPoPdfBuffer(po);
  assert.ok(Buffer.isBuffer(buf), 'is a Buffer');
  assert.ok(buf.length > 800, 'non-trivial size');
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-', 'is a PDF');
});

test('renderPoPdfBuffer survives a sparse / malformed PO without throwing', async () => {
  const buf = await renderPoPdfBuffer({ poNumber: '', items: [null], charges: [null], grandTotal: 0 });
  assert.ok(Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-');
});
