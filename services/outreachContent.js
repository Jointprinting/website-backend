// services/outreachContent.js
//
// Pure content helpers for the cold-outreach sender — no DB, no I/O, so they're
// unit-tested directly and mirrored 1:1 in the frontend editor preview
// (src/screens/studio/outreach/_outreach.js).
//
// The whole point: two recipients of the same step must NOT get a byte-identical
// email (the #1 pattern-filter fingerprint). Spintax varies the wording; the
// choice is DETERMINISTIC per (recipient, step) so a re-render / retry / preview
// always shows the same variant for the same recipient.

// Fast, stable 32-bit string hash (FNV-1a). Same implementation in the FE mirror
// so a preview and a real send resolve spins the same way for the same seed.
function hashStr(s) {
  let h = 2166136261;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Resolve spintax: every `{a|b|c}` group is replaced by ONE of its options,
// chosen deterministically from `seed` + the group's position so different
// groups vary independently but the same recipient always gets the same result.
//
// IMPORTANT ordering: run this AFTER the {{merge}} pass. `[^{}]` in the group
// pattern means it only ever matches single-brace spin groups and can never
// touch a {{merge|fallback}} token (which, post-merge, is already gone anyway).
// The lookbehind/lookahead guards `(?<!\{)…(?!\})` mean a spin group's braces
// must be SINGLE — so a `{{merge|fallback}}` token (double braces) is never
// matched, whether or not the merge pass ran first. Robust either way.
const SPIN_RE = /(?<!\{)\{([^{}]*\|[^{}]*)\}(?!\})/g;

function applySpintax(tpl, seed = '') {
  let i = 0;
  return String(tpl == null ? '' : tpl).replace(
    SPIN_RE,
    (_, group) => {
      const opts = group.split('|');
      const idx = hashStr(`${seed}:${i++}`) % opts.length;
      return opts[idx];
    },
  );
}

// Does a template contain spintax? (Cheap check for the editor to badge "varies".)
function hasSpintax(tpl) {
  return new RegExp(SPIN_RE.source).test(String(tpl || ''));
}

module.exports = { hashStr, applySpintax, hasSpintax };
