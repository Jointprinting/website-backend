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

// ── Content spam-linter ──────────────────────────────────────────────────────
// A pure, heuristic pre-send check that catches the obvious own-goals BEFORE a
// campaign launches — the deliverability equivalent of a spell-check. ADVISORY
// only: it never blocks a save, it just scores 0–100 and lists what to fix.
// Tuned NOT to flag our own legit copy ("free mockups", one catalog link): it
// targets classic spam phrasing, ALL-CAPS shouting, punctuation storms, link
// stuffing, and subject-line footguns.

// Classic cold-email spam phrases (mostly multi-word so plain "free" is fine).
const SPAM_PHRASES = [
  'act now', 'click here', 'buy now', 'order now', 'limited time', 'limited offer',
  '100% free', 'risk-free', 'risk free', 'money back', 'money-back', 'cash bonus',
  'make money', 'get paid', 'you have won', 'congratulations you', 'winner',
  'viagra', 'bitcoin', 'crypto', 'investment opportunity', 'double your',
  'lowest price', 'best price', 'why pay more', 'no credit check', 'apply now',
  'call now', 'wire transfer', 'this is not spam', 'dear friend',
];
const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
// Emoji-ish (covers the common pictographic ranges).
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;

const countMatches = (re, s) => (String(s || '').match(re) || []).length;

// Lint ONE message ({subject, body}). Returns { score, level, issues:[{level,code,msg}] }.
function lintContent({ subject = '', body = '' } = {}) {
  const subj = String(subject || '');
  const bod = String(body || '');
  const hay = `${subj}\n${bod}`.toLowerCase();
  const issues = [];
  const warn = (code, msg) => issues.push({ level: 'warn', code, msg });
  const info = (code, msg) => issues.push({ level: 'info', code, msg });

  // Spam phrases (dedup; cap the noise at a few).
  const hits = [...new Set(SPAM_PHRASES.filter((p) => hay.includes(p)))];
  if (hits.length) warn('spam-words', `Spam-trigger phrasing: ${hits.slice(0, 4).map((h) => `"${h}"`).join(', ')}${hits.length > 4 ? '…' : ''}`);

  // Subject line footguns.
  if (subj.trim().length > 70) warn('subject-long', `Subject is ${subj.trim().length} chars — aim for under ~60.`);
  if (subj.trim() && subj.trim().length < 3) info('subject-short', 'Subject is very short.');
  const subjLetters = subj.replace(/[^A-Za-z]/g, '');
  if (subjLetters.length >= 6 && subjLetters === subjLetters.toUpperCase()) warn('subject-caps', 'Subject is ALL CAPS — reads as shouting/spam.');
  if (EMOJI_RE.test(subj)) info('subject-emoji', 'Emoji in the subject can hurt cold B2B deliverability.');
  if (/[!?]{2,}/.test(subj) || countMatches(/!/g, subj) >= 2) warn('subject-punct', 'Too much !!! / ??? in the subject.');

  // Body punctuation / shouting.
  if (/!{3,}/.test(bod) || countMatches(/!/g, bod) >= 4) warn('body-punct', 'Lots of exclamation marks in the body.');
  const capsWords = (bod.match(/\b[A-Z]{4,}\b/g) || []).filter((w) => w !== 'FREE'); // one FREE is fine
  if (capsWords.length >= 3) info('body-caps', `${capsWords.length} ALL-CAPS words — go easy on emphasis.`);
  if (/\${3,}|\$\$/.test(hay) || hay.includes('$$$')) warn('money-symbols', 'Repeated $ / $$$ reads spammy.');

  // Links.
  const links = countMatches(URL_RE, bod);
  if (links > 3) warn('links', `${links} links — cold emails deliver best with 0–1.`);
  const textOnly = bod.replace(URL_RE, '').replace(/\s+/g, ' ').trim();
  if (links >= 1 && textOnly.length < 120) warn('bare-link', 'Mostly a link with little text — reads like a drive-by.');

  // Empty body.
  if (!bod.trim()) warn('empty-body', 'Body is empty.');

  const penalty = issues.reduce((n, i) => n + (i.level === 'warn' ? 15 : 5), 0);
  const score = Math.max(0, 100 - penalty);
  const level = score >= 80 ? 'ok' : score >= 55 ? 'warn' : 'action';
  return { score, level, issues };
}

// Lint every step of a campaign → [{ step, score, level, issues }]. A step
// running a subject A/B test gets its B arm linted through the same subject
// rules (body checks are skipped — the body is shared), tagged "Subject B:" so
// the owner knows which arm tripped.
function lintSteps(steps = []) {
  return (Array.isArray(steps) ? steps : []).map((s, i) => {
    const base = lintContent(s || {});
    const b = s && String(s.subjectB || '').trim();
    if (b) {
      const bIssues = lintContent({ subject: s.subjectB, body: 'x' }).issues // dummy body: skip empty-body noise
        .filter((iss) => iss.code.startsWith('subject') || iss.code === 'spam-words')
        .map((iss) => ({ ...iss, msg: `Subject B: ${iss.msg}` }));
      if (bIssues.length) {
        base.issues = [...base.issues, ...bIssues];
        const penalty = base.issues.reduce((n, x) => n + (x.level === 'warn' ? 15 : 5), 0);
        base.score = Math.max(0, 100 - penalty);
        base.level = base.score >= 80 ? 'ok' : base.score >= 55 ? 'warn' : 'action';
      }
    }
    return { step: i, ...base };
  });
}

module.exports = { hashStr, applySpintax, hasSpintax, lintContent, lintSteps };
