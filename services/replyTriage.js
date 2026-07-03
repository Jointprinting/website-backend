// services/replyTriage.js
//
// Gmail Reply Triage V1 — the pure classify + match logic behind the triage inbox
// (controllers/replyTriage.js). Deliberately keyword-based, no AI, no auto-send.
//
// No Gmail FETCHING lives here: V1 ingests replies manually / by import, and a real
// read-only Gmail sync is a gated V2 seam (isGmailConfigured) so we don't take on
// risky OAuth now. Keeping the classifier + matcher PURE means they're unit-tested
// without a DB or network — the same convention as the rest of the suite.

const { isSelf } = require('./selfIdentity');

// ── Enums (mirrored on the frontend: src/screens/studio/outreach/_outreach.js) ──

// The nine buckets the owner sorts a reply into.
const CATEGORIES = [
  'hot_lead',
  'needs_response',
  'asked_pricing',
  'asked_mockups',
  'follow_up_later',
  'not_interested',
  'wrong_person',
  'unsubscribe',
  'bounce_auto_ignore',
];

// Where a triaged reply sits in the owner's workflow. 'new' until they act on it.
// 'ignored' is the manual "this is noise, dismiss it" action (distinct from the
// auto-detected bounce_auto_ignore CATEGORY).
const STATUSES = [
  'new',
  'handled',
  'follow_up',
  'mockup_requested',
  'quote_requested',
  'not_interested',
  'do_not_contact',
  'ignored',
];

const SUGGESTED_ACTION = {
  hot_lead:           'High intent — call or email today',
  needs_response:     'Reply to keep it moving',
  asked_pricing:      'Send a quote — start it in the CRM',
  asked_mockups:      'Make a mockup — open Mockup Studio',
  follow_up_later:    'Schedule a follow-up',
  not_interested:     'Mark not interested; stop the sequence',
  wrong_person:       'Get the right contact; note it in the CRM',
  unsubscribe:        'Add to do-not-email and stop',
  bounce_auto_ignore: 'Ignore — no action needed',
};

const suggestedActionFor = (category) => SUGGESTED_ACTION[category] || SUGGESTED_ACTION.needs_response;

const isValidCategory = (c) => CATEGORIES.includes(c);
const isValidStatus = (s) => STATUSES.includes(s);

// ── Classification ─────────────────────────────────────────────────────────────

// Senders / subjects that are machine mail, never a human reply.
const AUTO_FROM = /(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notification|newsletter|@(?:bounce|mailer|email\.|em\.))/i;
const AUTO_SUBJECT = /(out of office|auto(?:matic)?[ -]?reply|automatic reply|delivery (?:status notification|has failed|failure)|undeliverable|returned mail|mail delivery (?:failed|subsystem)|failure notice|vacation|away from (?:the |my )?office|read receipt|accepted:|declined:|canceled:)/i;

// Content signals. Order below encodes precedence.
const RE_UNSUB = /\b(unsubscribe|remove me|take me off|stop (?:emailing|contacting|sending)|opt[ -]?out|do not (?:contact|email)|quit emailing)\b/i;
const RE_NOT_INTERESTED = /\b(not interested|no,? thank|no thanks|we'?re all set|already (?:have|use|using|work with|got)|not (?:at this time|right now|looking|a fit|for us)|no need|please stop|not needed)\b/i;
const RE_WRONG_PERSON = /\b(wrong (?:person|department|contact|email)|not the right|you'?ll want to (?:talk|speak|reach)|reach out to|please (?:contact|email)|forward(?:ing|ed)? (?:this|you|it) to|our (?:buyer|manager|owner|purchaser) (?:is|handles)|i'?m not (?:the|who)|no longer (?:with|here|at))\b/i;
const RE_PRICING = /(\bpric|\bquote|\bcost\b|how much|rate card|\brates?\b|\bbudget\b|\bestimate\b|per (?:unit|shirt|piece|item)|minimum order|\bMOQ\b)/i;
const RE_MOCKUP = /\b(mock[ -]?up|sample|proof|artwork|\bdesign\b|\blogo\b|see (?:a|some|the) (?:design|proof|sample)|send (?:over )?(?:a )?(?:design|proof|art))\b/i;
const RE_HOT = /\b(interested|let'?s (?:talk|chat|do it|connect|set)|call me|give me a call|set up (?:a )?(?:call|meeting|time)|ready to (?:go|order|start)|place an order|move forward|when can (?:we|you)|sounds good|let'?s go|i(?:'?d| would) like to (?:order|get|buy))\b/i;
const RE_LATER = /\b(not (?:right )?now|next (?:month|quarter|year|week|season)|circle back|reach back|check back|touch base (?:later|next)|after (?:the )?(?:holidays|summer|new year|season)|busy (?:right )?now|maybe (?:later|down the road)|revisit|in (?:a few|the) (?:weeks|months))\b/i;

// Classify one reply into a category. Precedence: kill-signals (self, machine mail,
// unsubscribe, not-interested) win over positive intent, so "unsubscribe — btw what
// are your prices" is never mis-filed as a pricing lead. `ignore` marks mail that
// isn't a real human reply (own sent mail, bounces, auto-replies).
function classifyReply({ subject = '', snippet = '', fromEmail = '', fromName = '' } = {}) {
  const from = String(fromEmail).toLowerCase();
  const hay = `${subject}\n${snippet}`;

  // Our own outbound mail is never a reply to triage.
  if (isSelf(from) || isSelf(fromName)) return { category: 'bounce_auto_ignore', ignore: true, self: true };

  if (AUTO_FROM.test(from) || AUTO_SUBJECT.test(subject)) return { category: 'bounce_auto_ignore', ignore: true, self: false };
  if (RE_UNSUB.test(hay))          return { category: 'unsubscribe',      ignore: false, self: false };
  if (RE_NOT_INTERESTED.test(hay)) return { category: 'not_interested',  ignore: false, self: false };
  if (RE_WRONG_PERSON.test(hay))   return { category: 'wrong_person',    ignore: false, self: false };
  if (RE_PRICING.test(hay))        return { category: 'asked_pricing',   ignore: false, self: false };
  if (RE_MOCKUP.test(hay))         return { category: 'asked_mockups',   ignore: false, self: false };
  if (RE_HOT.test(hay))            return { category: 'hot_lead',        ignore: false, self: false };
  if (RE_LATER.test(hay))          return { category: 'follow_up_later', ignore: false, self: false };
  return { category: 'needs_response', ignore: false, self: false };
}

// ── Matching ─────────────────────────────────────────────────────────────────

const normEmail = (e) => String(e == null ? '' : e).trim().toLowerCase();
// Drop leading Re:/Fwd:/Fw: markers so a reply subject can be compared to the
// campaign subject it's answering.
const normSubject = (s) => String(s == null ? '' : s).replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase();

// Match a reply to an existing outreach lead. PURE: the controller passes the
// candidate rows it already loaded (enrollments whose toEmail equals the sender,
// clients whose email/contact matches), so this needs no DB. Email is the strong
// signal; a subject still carrying our campaign's subject line is a soft fallback.
// Uncertain → matched:false (kept as UNMATCHED, never dropped, so nothing hides).
function matchReply(fromEmail, subject, { enrollments = [], clients = [] } = {}) {
  const from = normEmail(fromEmail);

  if (from) {
    const enr = enrollments.find((e) => normEmail(e.toEmail) === from);
    if (enr) return { matched: true, matchBy: 'email', companyKey: enr.companyKey || '', companyName: enr.companyName || '', enrollmentId: enr._id ? String(enr._id) : '' };

    const cl = clients.find((c) => normEmail(c.email) === from || (c.contacts || []).some((k) => normEmail(k.email) === from));
    if (cl) return { matched: true, matchBy: 'email', companyKey: cl.companyKey || '', companyName: cl.companyName || '', enrollmentId: '' };
  }

  const subj = normSubject(subject);
  if (subj) {
    const enr = enrollments.find((e) => (e.subjects || []).some((x) => normSubject(x) && normSubject(x) === subj));
    if (enr) return { matched: true, matchBy: 'subject', companyKey: enr.companyKey || '', companyName: enr.companyName || '', enrollmentId: enr._id ? String(enr._id) : '' };
  }

  return { matched: false, matchBy: 'none', companyKey: '', companyName: '', enrollmentId: '' };
}

// ── Follow-Up Command Center (Release 2) ────────────────────────────────────────

// Categories that represent a real human reply the owner should act on (i.e. not
// a bounce, an unsubscribe, or a clear "no"). Used to build the "needs a response"
// worklist bucket.
const ACTIONABLE_CATEGORIES = new Set([
  'hot_lead', 'needs_response', 'asked_pricing', 'asked_mockups', 'follow_up_later', 'wrong_person',
]);
// The strongest buying signals — sorted to the TOP of "needs a response".
const HOT_CATEGORIES = new Set(['hot_lead', 'asked_pricing', 'asked_mockups']);

const _ts = (d) => { const t = new Date(d).getTime(); return Number.isFinite(t) ? t : 0; };

// Group triage replies into the action buckets the command center shows. PURE:
// the controller passes the reply rows it loaded, so this is unit-tested without a
// DB. Buckets map 1:1 to the owner's reply→next-action workflow:
//   needsResponse   — new, real replies to answer (buying signals first)
//   quoteRequested  — they asked for pricing / a quote
//   mockupRequested — they asked for a mockup / proof
//   followUp        — owner tagged "follow up later"
// (do-not-contact / not-interested / ignored / handled drop out — they're done.)
function worklistFromReplies(replies = []) {
  const buckets = { needsResponse: [], quoteRequested: [], mockupRequested: [], followUp: [] };
  for (const r of replies) {
    if (r.status === 'quote_requested') buckets.quoteRequested.push(r);
    else if (r.status === 'mockup_requested') buckets.mockupRequested.push(r);
    else if (r.status === 'follow_up') buckets.followUp.push(r);
    else if (r.status === 'new' && ACTIONABLE_CATEGORIES.has(r.category)) buckets.needsResponse.push(r);
  }
  // Buying signals first, then most-recent first.
  buckets.needsResponse.sort((a, b) =>
    (HOT_CATEGORIES.has(b.category) ? 1 : 0) - (HOT_CATEGORIES.has(a.category) ? 1 : 0)
    || _ts(b.receivedAt) - _ts(a.receivedAt));
  // Oldest-waiting first for the follow-up buckets (don't let anyone rot).
  for (const k of ['quoteRequested', 'mockupRequested', 'followUp']) {
    buckets[k].sort((a, b) => _ts(a.receivedAt) - _ts(b.receivedAt));
  }
  return buckets;
}

// ── Gmail sync seam (V2) ───────────────────────────────────────────────────────
// V1 does NOT fetch from Gmail. This only reports whether a future read-only sync
// COULD run, so the UI can show an honest "not configured" hint and the /sync
// endpoint can no-op safely. Wiring the actual read-only fetch is a separate PR.
function isGmailConfigured() {
  return Boolean(
    process.env.GMAIL_TRIAGE_ENABLED === 'true' &&
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN,
  );
}

module.exports = {
  CATEGORIES,
  STATUSES,
  SUGGESTED_ACTION,
  suggestedActionFor,
  isValidCategory,
  isValidStatus,
  classifyReply,
  matchReply,
  normEmail,
  normSubject,
  isGmailConfigured,
  worklistFromReplies,
  ACTIONABLE_CATEGORIES,
  HOT_CATEGORIES,
};
