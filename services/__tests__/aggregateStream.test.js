// services/__tests__/aggregateStream.test.js
//
// The cannlytics ALL-STATES aggregate is a ~100MB whole-country CSV. Buffering
// + parsing it in memory OOM-killed the API host (Render "exited with status
// 134") minutes after the fallback shipped — the roster autopilot's boot kick
// hit it for OH on every restart, crash-looping the dyno. The fix streams the
// file through an incremental CSV parser and keeps ONLY the target state's
// rows. These tests pin the parser's chunk-boundary behavior and the
// collector's filtering / refusal / cap semantics.
//
//   node --test services/__tests__/aggregateStream.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { parseCsv, csvStreamParser, collectAggregateRowsForState } = require('../dispensaryIngest');

// ── csvStreamParser ≡ parseCsv, no matter how the text is chunked ────────────

const TRICKY_CSV = [
  'name,city,note,state',
  '"Quote ""Shop""",Akron,"has, comma",OH',
  'Plain Store,Toledo,ok,OH',
  '"Multi\nLine",Erie,"line\nbreak",PA',
  'Trail CR,Canton,crlf,OH',
].join('\r\n') + '\r\n';

function streamParse(text, chunkSize) {
  const rows = [];
  const p = csvStreamParser((r) => rows.push(r));
  for (let i = 0; i < text.length; i += chunkSize) p.push(text.slice(i, i + chunkSize));
  p.flush();
  return rows;
}

test('csvStreamParser matches parseCsv row-for-row at every chunk size', () => {
  const expected = parseCsv(TRICKY_CSV);
  for (const size of [1, 2, 3, 7, 64, TRICKY_CSV.length]) {
    const rows = streamParse(TRICKY_CSV, size);
    const headers = rows[0];
    const objs = rows.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => { if (h) o[h] = r[i] !== undefined ? r[i] : ''; });
      return o;
    });
    assert.deepEqual(objs, expected, `chunk size ${size}`);
  }
});

test('csvStreamParser: escaped quote pair split exactly across a chunk boundary', () => {
  // '"a""b"' → a"b — split between the two quote chars.
  const p1 = [];
  const parser = csvStreamParser((r) => p1.push(r));
  parser.push('"a"');
  parser.push('"b",x\n');
  parser.flush();
  assert.deepEqual(p1, [['a"b', 'x']]);
  // Same boundary, but the quote really was the closer.
  const p2 = [];
  const parser2 = csvStreamParser((r) => p2.push(r));
  parser2.push('"a"');
  parser2.push(',x\n');
  parser2.flush();
  assert.deepEqual(p2, [['a', 'x']]);
  // Closing quote as the very last byte of the input.
  const p3 = [];
  const parser3 = csvStreamParser((r) => p3.push(r));
  parser3.push('y,"z"');
  parser3.flush();
  assert.deepEqual(p3, [['y', 'z']]);
});

// ── collectAggregateRowsForState ─────────────────────────────────────────────

const AGG = [
  'premise_state,business_name,license_type,city',
  'OH,Buckeye Botanicals,Dispensary,Cleveland',
  'MI,Mitten Meds,Retailer,Detroit',
  'Ohio,Rubber City Remedies,Dispensary,Akron',
  'PA,Keystone Wellness,Dispensary Permit,Philadelphia',
  'OH,Lake Erie Leaf,Dispensary,Toledo',
].join('\n') + '\n';

const chunked = (text, size = 5) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(Buffer.from(text.slice(i, i + size)));
  return Readable.from(chunks);
};

test('collector keeps only the target state (code or full name), as header-keyed objects', async () => {
  const rows = await collectAggregateRowsForState(chunked(AGG), 'OH', 'Ohio');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.business_name), ['Buckeye Botanicals', 'Rubber City Remedies', 'Lake Erie Leaf']);
  assert.equal(rows[0].premise_state, 'OH');
  assert.equal(rows[0].city, 'Cleveland');
});

test('collector: a different state pulls its own rows from the same file', async () => {
  const rows = await collectAggregateRowsForState(chunked(AGG), 'PA', 'Pennsylvania');
  assert.deepEqual(rows.map((r) => r.business_name), ['Keystone Wellness']);
});

test('collector refuses a file with no recognizable state column', async () => {
  const noState = 'business_name,city\nBuckeye Botanicals,Cleveland\n';
  await assert.rejects(
    () => collectAggregateRowsForState(chunked(noState), 'OH', 'Ohio'),
    /no state column/
  );
});

test('collector enforces the byte cap instead of buffering forever', async () => {
  await assert.rejects(
    () => collectAggregateRowsForState(chunked(AGG), 'OH', 'Ohio', { maxBytes: 40 }),
    /exceeded/
  );
});

test('collector enforces the kept-row cap', async () => {
  await assert.rejects(
    () => collectAggregateRowsForState(chunked(AGG), 'OH', 'Ohio', { maxRows: 1 }),
    /matched >1 rows/
  );
});

test('collector surfaces stream errors', async () => {
  const bad = new Readable({ read() { this.destroy(new Error('boom mid-download')); } });
  await assert.rejects(
    () => collectAggregateRowsForState(bad, 'OH', 'Ohio'),
    /boom mid-download/
  );
});

test('collector times out a stalled stream instead of wedging the serialized queue', async () => {
  const stalled = new Readable({ read() { /* never emits, never ends */ } });
  await assert.rejects(
    () => collectAggregateRowsForState(stalled, 'OH', 'Ohio', { idleMs: 30 }),
    /stalled/
  );
});

test('collector splits multi-byte UTF-8 across chunks without corruption', async () => {
  const utf = 'premise_state,business_name\nOH,Café Cannabis — Ohio\n';
  const buf = Buffer.from(utf);
  // 1-byte chunks guarantee é and — are split mid-sequence.
  const chunks = [];
  for (let i = 0; i < buf.length; i++) chunks.push(buf.subarray(i, i + 1));
  const rows = await collectAggregateRowsForState(Readable.from(chunks), 'OH', 'Ohio');
  assert.equal(rows[0].business_name, 'Café Cannabis — Ohio');
});
