// Shared pdfkit image helpers. Turn a stored image value — a base64 data URL or
// an R2 https URL — into a Buffer pdfkit can embed. Extracted from
// controllers/confirmationPdf.js so the lookbook PDF (and anything else) reuses
// the exact same resolution, and there's one place that knows how studio images
// are stored. Null-safe by design: a single bad image returns null instead of
// aborting the whole document.

const axios = require('axios');

// data:image/png;base64,... → Buffer (pdfkit only reads PNG/JPEG)
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch (_) { return null; }
}

// Resolve an image value (base64 data URL OR an http(s) URL — e.g. an R2 link)
// to a Buffer pdfkit can embed. Images moved to R2 are stored as URLs, so the
// PDF fetches them; legacy base64 still works. Returns null on any failure so a
// single bad image never aborts the whole PDF.
async function resolveImageBuffer(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.startsWith('data:')) return dataUrlToBuffer(value);
  if (/^https?:\/\//i.test(value)) {
    try {
      const r = await axios.get(value, { responseType: 'arraybuffer', timeout: 15000 });
      return Buffer.from(r.data);
    } catch (_) { return null; }
  }
  return null;
}

module.exports = { dataUrlToBuffer, resolveImageBuffer };
