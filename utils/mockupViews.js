// utils/mockupViews.js
//
// Every image of ONE mockup, in reading order, for a client-facing surface.
//
// A mockup document spreads its views across four fields:
//
//   thumbnail       page 1 front
//   data            page 1 back
//   extraViews      pages 2+ FRONTS   (compacted — see the alignment note)
//   extraBackViews  pages 2+ BACKS    (index-aligned to pages[1..], '' padded)
//
// Three surfaces render that set — the owner's confirmation builder preview, the
// client's approval page, and the confirmation PDF — and they are required to
// agree image-for-image (the WYSIWYG invariant the builder comments call H1).
// They each rebuilt the list inline, and every one of them stopped at
// extraViews: the back of page 2+ has been persisted since the page-2-back fix
// and has never once been shown to a client. This is that list, computed once.
//
// ── The alignment rule ───────────────────────────────────────────────────────
// `extraViews` is written with `.filter(Boolean)` (an extra page with no front
// composite is dropped), while `extraBackViews` keeps its slot with an ''
// placeholder. So the two arrays line up ONLY when nothing was dropped, which is
// exactly when their lengths match. Pairing them any other time would print one
// page's back under another page's front — the misalignment hazard that kept
// extraBackViews out of the light summary payload in the first place.
//
// So: equal lengths → interleave front/back per page. Otherwise → fronts first,
// then whatever backs exist, unpaired. Nothing is invented and nothing is lost.
//
// Pure + dependency-free. MIRRORS src/common/mockupViews.js in the frontend —
// keep the two in step.

const _list = (v) => (Array.isArray(v) ? v : []);

// The extra pages' images in reading order, honouring the alignment rule above.
// `includeBack` false → fronts only (the client opted out of backs on this item).
function extraPageViews(extraViews, extraBackViews, includeBack) {
  const fronts = _list(extraViews);
  const backs = includeBack ? _list(extraBackViews) : [];
  if (!backs.length) return fronts.filter(Boolean);
  if (backs.length !== fronts.length) {
    // Can't know which back belongs to which page — show them all, unpaired,
    // rather than pairing them wrongly.
    return [...fronts.filter(Boolean), ...backs.filter(Boolean)];
  }
  const out = [];
  fronts.forEach((f, i) => {
    if (f) out.push(f);
    if (backs[i]) out.push(backs[i]);
  });
  return out;
}

// Every view of one mockup, front-then-back, page by page.
//
// `mockup` takes either shape the surfaces already carry:
//   { front, back, extraViews, extraBackViews }   (the PDF/builder entry)
//   { thumbnail, data, ... }                      (a raw library document)
//
// `includeBack` gates the BACKS — page 1's and every extra page's alike. The
// confirmation item's `showBack` opt-in drives it: a plain garment back is
// noise on a client document unless the owner said it matters. A surface with
// no such toggle (the pre-confirmation gallery, where the client is reviewing
// the designs themselves) passes true and sees everything.
function mockupViewList(mockup, opts) {
  const m = mockup || {};
  const includeBack = !opts || opts.includeBack !== false;
  const front = m.front != null ? m.front : m.thumbnail;
  const back = m.back != null ? m.back : m.data;
  return [
    front,
    includeBack ? back : null,
    ...extraPageViews(m.extraViews, m.extraBackViews, includeBack),
  ].filter(Boolean);
}

module.exports = { mockupViewList, extraPageViews };
