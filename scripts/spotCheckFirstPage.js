// scripts/spotCheckFirstPage.js
//
// Spot-check the products landing page: prints the featured marquee + the first
// grid page exactly as a visitor sees them, with each card's "Starting at $X",
// then a price histogram and a "most common price share" so you can confirm the
// first page is NOT majority the same number.
//
// Runs against a live backend (which holds the S&S credentials) — it does NOT
// need S&S creds itself.
//
//   node scripts/spotCheckFirstPage.js
//   BACKEND_URL=https://your-api.example.com node scripts/spotCheckFirstPage.js
//
// Exit code is non-zero if one price covers >50% of the first grid page, so this
// can double as a CI guard if you ever wire one up.

const axios = require('axios');

const BASE = process.env.BACKEND_URL || 'http://localhost:8080';
const LIMIT = parseInt(process.env.LIMIT || '24', 10);

function histogram(rows) {
  const counts = new Map();
  for (const r of rows) {
    const key = r.priceFrom != null ? `$${r.priceFrom}` : '(none)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function printRows(title, rows) {
  console.log(`\n${title} (${rows.length})`);
  console.log('─'.repeat(64));
  for (const r of rows) {
    const price = r.priceFrom != null ? `$${r.priceFrom}` : '—';
    console.log(
      `  ${String(price).padStart(5)}  ${String(r.category || '').padEnd(12)} ` +
      `${String(r.vendor || '').padEnd(22)} ${r.style || ''}  ${(r.name || '').slice(0, 40)}`
    );
  }
}

(async () => {
  console.log(`Spot-checking ${BASE}/api/products/ss/browse?page=1&limit=${LIMIT}`);
  let data;
  try {
    ({ data } = await axios.get(`${BASE}/api/products/ss/browse`, {
      params: { page: 1, limit: LIMIT },
      timeout: 60_000,
    }));
  } catch (e) {
    console.error('Request failed:', e.response?.data?.message || e.message);
    console.error('Is the backend running and are SS_ACCOUNT/SS_API_KEY set there?');
    process.exit(2);
  }

  const featured = data.featured || [];
  const products = data.products || [];

  if (featured.length) printRows('FEATURED marquee', featured);
  printRows('GRID — first page', products);

  const hist = histogram(products);
  console.log('\nPrice distribution (grid first page)');
  console.log('─'.repeat(64));
  for (const [price, n] of hist) {
    const pct = Math.round((n / products.length) * 100);
    console.log(`  ${price.padStart(6)}  ${String(n).padStart(3)}  ${'█'.repeat(n)} ${pct}%`);
  }

  const distinct = hist.length;
  const topShare = products.length ? hist[0][1] / products.length : 0;
  console.log(
    `\nDistinct prices: ${distinct} · most common: ${hist[0]?.[0]} ` +
    `(${Math.round(topShare * 100)}% of the page)`
  );

  if (topShare > 0.5) {
    console.log('⚠  One price covers >50% of the first page — still looks monotone.');
    process.exit(1);
  }
  console.log('✓  First page shows a healthy spread of prices.');
})();
