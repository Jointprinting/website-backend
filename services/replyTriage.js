// services/replyTriage.js
//
// Gmail Reply Triage — the pure classify + match logic behind the triage inbox
// (controllers/replyTriage.js). Deliberately keyword-based, no AI, no auto-send
// of new mail. What it DOES drive (in the controller) is the loop-closing
// behavior: a matched human reply auto-stops the drip and warms the CRM, an
// opt-out suppresses the address, and an out-of-office auto-reply snoozes the
// sequence instead of firing into an empty office.
//
// Keeping the classifier + matcher PURE means they're unit-tested without a DB
// or network — the same convention as the rest of the suite.

const { isSelf } = require('./selfIdentity');

// ── Enums (mirrored on the frontend: src/screens/studio/outreach/_outreach.js) ──

// The buckets the owner sorts a reply into. `auto_reply_ooo` is machine-ish but
// NOT noise — it's a real mailbox temporarily away, so it gets its own category
// and the controller snoozes the sequence rather than ignoring it.
const CATEGORIES = [
  'hot_lead',
  'needs_response',
  'asked_pricing',
  'asked_mockups',
  'follow_up_later',
  'not_interested',
  'wrong_person',
  'unsubscribe',
  'auto_reply_ooo',
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
  auto_reply_ooo:     'Auto-reply — sequence paused, resumes automatically',
  bounce_auto_ignore: 'Ignore — no action needed',
};

const suggestedActionFor = (category) => SUGGESTED_ACTION[category] || SUGGESTED_ACTION.needs_response;

const isValidCategory = (c) => CATEGORIES.includes(c);
const isValidStatus = (s) => STATUSES.includes(s);

// ── Classification ─────────────────────────────────────────────────────────────

// Senders that are machine mail, never a human reply.
const AUTO_FROM = /(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notification|newsletter|@(?:bounce|mailer|email\.|em\.))/i;

// SaaS / big-tech / platform sender domains — the services WE use, not shops we
// pitch. Mail FROM these is product/billing/security noise by definition (the
// bug: "workspace@google.com — [Reminder] Your Google Workspace free trial is
// ending" classified as needs_response and sat in the worklist as a lead). No
// dispensary buyer writes from @google.com or @stripe.com, so a domain-suffix
// match here is safe to hard-ignore. Suffix match honors the dot boundary
// (mail.google.com hits, notagoogle.com does not).
const VENDOR_NOISE_DOMAINS = [
  'google.com', 'youtube.com', 'microsoft.com', 'apple.com', 'intuit.com',
  'stripe.com', 'paypal.com', 'squareup.com', 'shopify.com', 'godaddy.com',
  'squarespace.com', 'wix.com', 'mailchimp.com', 'hubspot.com', 'salesforce.com',
  'adobe.com', 'dropbox.com', 'zoom.us', 'slack.com', 'atlassian.com',
  'github.com', 'vercel.com', 'render.com', 'cloudflare.com', 'namecheap.com',
  'docusign.com', 'canva.com', 'calendly.com', 'notion.so', 'anthropic.com',
  'openai.com', 'mongodb.com', 'twilio.com', 'sendpulse.com', 'sendgrid.net',
  'facebookmail.com', 'instagram.com', 'linkedin.com', 'tiktok.com',
  'amazon.com', 'ups.com', 'fedex.com', 'usps.com', 'dhl.com',
];
function isVendorNoiseSender(fromEmail) {
  const dom = domainOf(fromEmail);
  if (!dom) return false;
  return VENDOR_NOISE_DOMAINS.some((d) => dom === d || dom.endsWith(`.${d}`));
}
// Hard delivery failures + calendar/receipt noise → ignore entirely.
const BOUNCE_SUBJECT = /(delivery (?:status notification|has failed|failure)|undeliverable|returned mail|mail delivery (?:failed|subsystem)|failure notice|read receipt|accepted:|declined:|canceled:)/i;
// Out-of-office / vacation auto-responders — a REAL mailbox that's temporarily
// away. Detected separately so the controller can snooze-and-resume the drip.
const OOO_SUBJECT = /\b(out of (?:the )?office|auto(?:matic)?[ -]?reply|automatic reply|on vacation|away from (?:the |my )?office|on (?:leave|holiday|pto)|maternity leave|paternity leave)\b/i;
const OOO_BODY = /\b(i(?:'| a)?m (?:currently )?(?:out of (?:the )?office|on (?:vacation|leave|pto|holiday)|away|traveling)|out of (?:the )?office (?:until|through|from|and)|automatic(?:ally)? (?:generated )?(?:reply|response)|this is an autom(?:ated|atic)|limited access to (?:my )?email)\b/i;

// Generic (non-OOO) auto-responders / auto-acknowledgements — a machine, not a
// human, replied. These must NEVER count as a real reply (the bug: an "Auto
// response: …" from a shop's real address that says "thank you for contacting …
// this account is not monitored" got treated as a buyer reply and warmed the CRM).
// Distinct from OOO (a person temporarily away, which we snooze): these are ignored.
const AUTO_ACK_SUBJECT = /\b(auto[\s-]?response|automatic response|autoresponse|auto[\s-]?acknowledge?ment|acknowledg?ement of your|we(?:'ve| have) received your|your (?:message|email|inquiry|request) (?:has been|was) received|thank you for contacting)\b/i;
// Body wording is MACHINE-SPECIFIC only — phrases a human would never write in a
// real reply. A polite human opener ("thank you for your email, yes we'd love a
// quote") must NOT be swallowed, so soft openers are deliberately excluded here;
// a generic auto-ack is still caught by its subject (AUTO_ACK_SUBJECT) or headers.
const AUTO_ACK_BODY = /\b(this is an automated (?:response|message|email|reply)|(?:please )?do not (?:reply|respond) to this (?:e-?mail|message|account|mailbox)|this (?:mailbox|inbox|e-?mail account|account) is (?:not |un)monitored|is not monitored|unlikely (?:they|it) will (?:be seen|not be seen)|can ?not be answered via this (?:e-?mail|account)|no longer monitored|(?:ticket|case|reference) (?:number|#)\s*[:#]?\s*\w|support (?:ticket|request) (?:has been )?(?:created|received|opened)|your (?:message|email|inquiry|request) (?:has been|was) received and|a (?:member of our|our) team will (?:be in touch|respond|get back)|this is a no-?reply)\b/i;

// HIGH-PRECISION auto-ack combo (the Origins Cannabis case): a dispensary's
// autoresponder from a REAL, monitored address whose wording alone doesn't trip
// the patterns above — it opens by ACKNOWLEDGING our message and then DEFERS a
// real answer to later ("thanks for reaching out — we'll get back to you within
// 24-48 hours"). Neither half is auto on its own (a human sales rep writes
// "thanks for reaching out, yes we'd love to quote you"), so we require BOTH an
// acknowledgement AND a no-substance defer-to-later promise. That combo is
// something a genuine 1:1 reply essentially never contains, so it's safe to
// treat as a machine ack and NOT warm the CRM.
const ACK_OPENER = /\b(thank(?:s| you)(?: (?:so|very) much)? for (?:reaching out|contacting|getting in touch|your (?:e-?mail|message|inquiry|interest|note|patience|order|submission))|we(?:'ve| have| just)?(?: recently)? received your (?:message|e-?mail|inquiry|request|order|note|submission))\b/i;
const DEFER_RESPONSE = /\b((?:we|someone|a (?:team )?member|our team|a representative|somebody)(?:'ll| will| are going to| shall)? (?:be in touch|get back to you|respond|reply to you|contact you|reach out to you)|within \d+\s*(?:-\s*\d+\s*)?(?:business )?(?:hours?|days?|hrs?|business days?)|as soon as (?:possible|we can|we are able)|response time|(?:currently )?(?:experiencing |receiving )?(?:a )?high (?:volume|number) of|during (?:our )?(?:regular |normal |standard )?business hours)\b/i;
function isAutoAckCombo(hay) {
  return ACK_OPENER.test(hay) && DEFER_RESPONSE.test(hay);
}

// RFC-standard headers that DEFINITIVELY mark automated / bulk / list mail — the
// gold-standard signal, independent of fragile subject/body wording. A well-behaved
// auto-responder sets `Auto-Submitted: auto-replied` (RFC 3834); bulk/list senders
// set `Precedence: bulk|list` or `List-Id`; Outlook/Exchange set `X-Auto-Response-
// Suppress`. A genuine 1:1 human reply from Gmail/Outlook carries none of these.
function headerSaysAuto(headers) {
  if (!headers || typeof headers !== 'object') return false;
  const get = (k) => {
    const key = Object.keys(headers).find((h) => h.toLowerCase() === k);
    return key ? String(headers[key] == null ? '' : headers[key]) : '';
  };
  const autoSub = get('auto-submitted').trim().toLowerCase();
  if (autoSub && autoSub !== 'no') return true;                         // RFC 3834
  if (/\b(bulk|auto[_-]?reply|auto[_-]?generated|junk|list)\b/i.test(get('precedence'))) return true;
  if (get('x-autoreply') || get('x-autorespond') || get('x-autoresponse')) return true;
  if (get('x-auto-response-suppress')) return true;                    // Exchange/Outlook auto
  if (get('x-autoreply-from') || get('x-mail-autoreply') || get('x-vacation')) return true;
  if (get('list-id') || get('list-unsubscribe-post')) return true;     // mailing-list / bulk, not a person
  // Bulk/marketing fingerprints a genuine 1:1 human reply never carries:
  // List-Unsubscribe (any form — every transactional/marketing sender sets it,
  // e.g. the Google Workspace billing reminders), Feedback-ID (Gmail's bulk-
  // sender loop), and the big ESPs' injection headers.
  if (get('list-unsubscribe')) return true;
  if (get('feedback-id') || get('x-feedback-id')) return true;
  if (get('x-sg-eid') || get('x-mailgun-sid') || get('x-ses-outgoing') || get('x-mandrill-user')) return true;
  return false;
}

// Content signals. Order below encodes precedence.
const RE_UNSUB = /\b(unsubscribe|remove me|take me off|stop (?:emailing|contacting|sending)|opt[ -]?out|do not (?:contact|email)|quit emailing)\b/i;
const RE_NOT_INTERESTED = /\b(not interested|no,? thank|no thanks|we'?re all set|already (?:have|use|using|work with|got)|not (?:at this time|right now|looking|a fit|for us)|no need|please stop|not needed)\b/i;
const RE_WRONG_PERSON = /\b(wrong (?:person|department|contact|email)|not the right|you'?ll want to (?:talk|speak|reach)|reach out to|please (?:contact|email)|forward(?:ing|ed)? (?:this|you|it) to|our (?:buyer|manager|owner|purchaser) (?:is|handles)|i'?m not (?:the|who)|no longer (?:with|here|at))\b/i;
const RE_PRICING = /(\bpric|\bquote|\bcost\b|how much|rate card|\brates?\b|\bbudget\b|\bestimate\b|per (?:unit|shirt|piece|item)|minimum order|\bMOQ\b)/i;
const RE_MOCKUP = /\b(mock[ -]?up|sample|proof|artwork|\bdesign\b|\blogo\b|see (?:a|some|the) (?:design|proof|sample)|send (?:over )?(?:a )?(?:design|proof|art))\b/i;
const RE_HOT = /\b(interested|let'?s (?:talk|chat|do it|connect|set)|call me|give me a call|set up (?:a )?(?:call|meeting|time)|ready to (?:go|order|start)|place an order|move forward|when can (?:we|you)|sounds good|let'?s go|i(?:'?d| would) like to (?:order|get|buy))\b/i;
const RE_LATER = /\b(not (?:right )?now|next (?:month|quarter|year|week|season)|circle back|reach back|check back|touch base (?:later|next)|after (?:the )?(?:holidays|summer|new year|season)|busy (?:right )?now|maybe (?:later|down the road)|revisit|in (?:a few|the) (?:weeks|months))\b/i;

// Classify one reply into a category. Precedence: kill-signals (self, machine
// bounce, OOO, unsubscribe, not-interested) win over positive intent, so
// "unsubscribe — btw what are your prices" is never mis-filed as a pricing lead.
// Returns { category, ignore, self, ooo }: `ignore` = not a real human reply to
// act on; `ooo` = an out-of-office auto-reply the caller should snooze on.
function classifyReply({ subject = '', snippet = '', fromEmail = '', fromName = '', headers = null } = {}) {
  const from = String(fromEmail).toLowerCase();
  const subj = String(subject);
  const body = String(snippet);
  const hay = `${subj}\n${body}`;

  // Our own outbound mail is never a reply to triage.
  if (isSelf(from) || isSelf(fromName)) return { category: 'bounce_auto_ignore', ignore: true, self: true };

  // Hard machine mail (bounces, receipts, calendar) and platform/vendor senders
  // (Google/Stripe/UPS/… product-billing-security noise) → ignore.
  if (AUTO_FROM.test(from) || BOUNCE_SUBJECT.test(subj) || isVendorNoiseSender(from)) {
    return { category: 'bounce_auto_ignore', ignore: true, self: false };
  }
  // Out-of-office auto-reply (a real person temporarily away) → its own category
  // (snooze, don't ignore). Checked BEFORE the generic auto-ack so a true OOO
  // resumes the sequence instead of being dropped.
  if (OOO_SUBJECT.test(subj) || OOO_BODY.test(body)) return { category: 'auto_reply_ooo', ignore: false, self: false, ooo: true };
  // Generic auto-responder / bulk / list mail — flagged by RFC headers
  // (Auto-Submitted / Precedence / X-Auto*) or by the message's own auto-ack
  // wording ("Auto response: …", "thank you for contacting …", "this mailbox is
  // not monitored"). A machine acknowledged us — NEVER a real reply, so ignore it
  // outright (no CRM warm, no "Replied" state). This is the fix for auto-replies
  // that used to slip through and pollute the pipeline.
  if (headerSaysAuto(headers) || AUTO_ACK_SUBJECT.test(subj) || AUTO_ACK_BODY.test(hay)) {
    return { category: 'bounce_auto_ignore', ignore: true, self: false, auto: true };
  }

  if (RE_UNSUB.test(hay))          return { category: 'unsubscribe',      ignore: false, self: false };
  if (RE_NOT_INTERESTED.test(hay)) return { category: 'not_interested',  ignore: false, self: false };
  if (RE_WRONG_PERSON.test(hay))   return { category: 'wrong_person',    ignore: false, self: false };
  if (RE_PRICING.test(hay))        return { category: 'asked_pricing',   ignore: false, self: false };
  if (RE_MOCKUP.test(hay))         return { category: 'asked_mockups',   ignore: false, self: false };
  if (RE_HOT.test(hay))            return { category: 'hot_lead',        ignore: false, self: false };
  if (RE_LATER.test(hay))          return { category: 'follow_up_later', ignore: false, self: false };
  // The fuzzy auto-ack combo runs LAST, only when NO real buying signal fired —
  // a "thanks, someone will be in touch, but send me a mockup?" already resolved
  // to asked_mockups above. What's left here (acknowledge + defer, no substance)
  // is the novel autoresponder (the Origins case) — ignore it, don't warm.
  if (isAutoAckCombo(hay)) {
    return { category: 'bounce_auto_ignore', ignore: true, self: false, auto: true };
  }
  return { category: 'needs_response', ignore: false, self: false };
}

// ── Promotional / transactional shape (the unmatched-mail gate) ───────────────
// Wording that marks product/marketing/billing mail rather than a person
// answering us: trials, subscriptions, invoices, security alerts, webinars,
// percent-off blasts, "view in browser" chrome. NEVER applied to a matched
// reply or to one that already showed explicit intent (asked_pricing etc.) —
// it only downgrades the fallback needs_response on mail from a sender we
// never emailed, where "reply to keep it moving" is meaningless.
const PROMO_SHAPE = new RegExp([
  /\bfree trial\b|\btrial (?:is )?(?:ending|expir\w+|over)\b/.source,
  /\byour (?:subscription|invoice|receipt|statement|billing|payment|plan|order (?:has )?shipped|account)\b/.source,
  /\bpayment (?:due|failed|received|method)\b|\bbilling (?:period|statement|reminder)\b/.source,
  /\brenewal (?:notice|reminder)\b|\bprice (?:change|increase)\b|\bupgrade (?:now|today|your)\b/.source,
  /\bverify your (?:e-?mail|account)\b|\bsecurity alert\b|\bnew sign[- ]?in\b|\bpassword (?:reset|expir\w+)\b/.source,
  /\bwelcome to\b|\bgetting started with\b|\bwebinar\b|\bproduct updates?\b|\brelease notes\b/.source,
  /\b\d{1,2}% off\b|\bsale ends\b|\blimited[- ]time\b|\blast chance\b|\bcoupon\b|\bpromo code\b/.source,
  /\bview (?:this email )?in (?:your )?browser\b|\bmanage (?:your )?(?:preferences|notifications)\b/.source,
  /\bterms of service\b|\bprivacy policy\b|\[reminder\]/.source,
].join('|'), 'i');

function looksPromotional({ subject = '', snippet = '' } = {}) {
  return PROMO_SHAPE.test(`${subject}\n${snippet}`);
}

// Final say on a classified reply once the MATCH is known. classifyReply runs
// before matching (it has no DB); this pure post-pass closes the remaining gap:
// a sender we never emailed, no buying signal, promotional/transactional shape
// → machine mail, not a lead. Everything matched — and every unmatched message
// with real intent or a plain human question — passes through untouched, so a
// genuine cold inquiry ("do you print hoodies?") still reaches the worklist.
function finalizeCategory({ category, matched, subject = '', snippet = '' } = {}) {
  if (category === 'needs_response' && !matched && looksPromotional({ subject, snippet })) {
    return { category: 'bounce_auto_ignore', ignore: true, downgraded: true };
  }
  return { category, ignore: category === 'bounce_auto_ignore', downgraded: false };
}

// Parse an out-of-office "back on <date>" into a resume Date. Best-effort: an
// explicit M/D (optionally /YY) that reads as a plausible near-future return
// (1–45 days out) is honored; otherwise we default to +7 days. PURE (now
// injected) so it's unit-tested without the clock.
function parseOooResume(text, now = new Date()) {
  const base = now instanceof Date ? now : new Date(now);
  const DEFAULT = new Date(base.getTime() + 7 * 86400000);
  const m = String(text || '').match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const mo = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    let yr = m[3] ? parseInt(m[3], 10) : base.getUTCFullYear();
    if (yr < 100) yr += 2000;
    if (mo >= 0 && mo <= 11 && day >= 1 && day <= 31) {
      const cand = new Date(Date.UTC(yr, mo, day, 14, 0, 0)); // ~9-10a ET
      const days = (cand.getTime() - base.getTime()) / 86400000;
      if (Number.isFinite(days) && days >= 1 && days <= 45) return cand;
    }
  }
  return DEFAULT;
}

// ── Bounce NDR ingestion (async bounces on Gmail SMTP) ───────────────────────
// Google Workspace SMTP reports most dead mailboxes ASYNCHRONOUSLY: the send is
// accepted on the wire, then a "Delivery Status Notification" EMAIL lands in the
// inbox. Those classify as bounce_auto_ignore — and ignoring them entirely means
// a dead address keeps receiving touches 2/3/4 (a strong spam signal) and the
// bounce circuit-breaker never sees the failure. classifyBounceNdr() turns an
// NDR into { isBounce, hard, emails } so the controller can suppress + stop on
// HARD failures only. Soft failures (mailbox full, greylist, deferred) must
// never kill a good lead — the drip's backoff already handles them. PURE.

const NDR_FROM = /(mailer-daemon|postmaster)/i;
const NDR_SUBJECT = /(delivery (?:status notification|has failed|failure)|undeliverable|returned mail|mail delivery (?:failed|subsystem)|failure notice|message not delivered|delivery incomplete)/i;
const NDR_HARD = /(address (?:not found|unknown|rejected)|user (?:unknown|not found)|no such (?:user|recipient|address)|does(?:n'?t| not) exist|mailbox (?:unavailable|not found|does not exist)|recipient (?:not found|rejected)|address rejected|account .{0,40}disabled|550[- ]?5\.1\.1|\b5\.1\.[0-9]\b|permanent(?:ly)? (?:fail|error|reject))/i;
const NDR_SOFT = /(mailbox (?:is )?full|over quota|quota exceeded|try again later|temporar(?:y|ily)|deferred|greylist|\b4\.\d\.\d\b|rate limit|server busy)/i;
const NDR_JUNK_LOCAL = /(mailer-daemon|postmaster|no-?reply|do-?not-?reply|abuse|bounce)/i;

function classifyBounceNdr({ subject = '', snippet = '', fromEmail = '' } = {}, ourDomains = []) {
  const from = String(fromEmail || '').toLowerCase();
  const subj = String(subject || '');
  const body = String(snippet || '');
  const isBounce = NDR_FROM.test(from) || NDR_SUBJECT.test(subj);
  if (!isBounce) return { isBounce: false, hard: false, emails: [] };
  const hay = `${subj}\n${body}`;
  // Hard only when a permanent signal is present AND no transient one — when in
  // doubt, do nothing (the conservative default for anything that kills a lead).
  const hard = NDR_HARD.test(hay) && !NDR_SOFT.test(hay);
  // Soft = a transient failure notice ("temporary problem… will retry",
  // mailbox full, deferred). Never kills a lead by itself, but the drip must
  // STOP stacking more mail onto a struggling mailbox — the controller defers
  // the enrollment and escalates to suppression only after repeated notices.
  const soft = !hard && NDR_SOFT.test(hay);
  // The failed recipient(s): every address in the NDR that isn't a daemon and
  // isn't on OUR sending/replying domains (those appear in the quoted original).
  const ours = new Set((ourDomains || []).map((d) => String(d || '').toLowerCase()).filter(Boolean));
  const emails = [...new Set((hay.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
    .map((e) => e.toLowerCase())
    .filter((e) => !NDR_JUNK_LOCAL.test(e.split('@')[0] || ''))
    .filter((e) => !ours.has(e.split('@')[1] || '')))];
  return { isBounce: true, hard, soft, emails };
}

// ── Matching ─────────────────────────────────────────────────────────────────

const normEmail = (e) => String(e == null ? '' : e).trim().toLowerCase();
const domainOf = (e) => { const s = normEmail(e); const i = s.lastIndexOf('@'); return i >= 0 ? s.slice(i + 1) : ''; };
const stripAngles = (s) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().toLowerCase();
// Drop leading Re:/Fwd:/Fw: markers so a reply subject can be compared to the
// campaign subject it's answering.
const normSubject = (s) => String(s == null ? '' : s).replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase();

// Freemail / consumer domains — many different shops share these, so a
// domain-only match against one is meaningless and must never fire.
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'hotmail.co.uk',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'gmx.net', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'ymail.co', 'mail.com', 'zoho.com',
]);

// Match confidence, strongest → weakest. STRONG matches are safe to auto-act on
// (stop the drip, warm the CRM); a 'domain' match is a soft link the UI shows
// but the loop never auto-acts on.
const STRONG_MATCHES = new Set(['thread', 'email', 'subject']);

function hit(matchBy, enr) {
  return {
    matched: true, matchBy,
    companyKey: enr.companyKey || '',
    companyName: enr.companyName || '',
    enrollmentId: enr._id ? String(enr._id) : '',
  };
}

// Match a reply to an existing outreach lead. PURE: the controller passes the
// candidate rows it already loaded, so this needs no DB. Order = confidence:
//   1) thread   — the reply's In-Reply-To/References vs a send's Message-ID
//   2) email    — exact sender address (enrollment, then any client contact)
//   3) subject  — the reply still carries our campaign's subject line
//   4) domain   — same BUSINESS domain, different mailbox (soft; skips freemail)
// Uncertain → matched:false (kept as UNMATCHED, never dropped, so nothing hides).
function matchReply(fromEmail, subject, { enrollments = [], clients = [], messageIds = [] } = {}) {
  const from = normEmail(fromEmail);

  // 1) Thread headers — strongest signal, survives a reply from any address.
  const refSet = new Set((messageIds || []).map(stripAngles).filter(Boolean));
  if (refSet.size) {
    const enr = enrollments.find((e) => {
      const ids = (e.messageIds && e.messageIds.length)
        ? e.messageIds
        : (e.sends || []).map((s) => s && s.messageId);
      return (ids || []).map(stripAngles).some((id) => id && refSet.has(id));
    });
    if (enr) return hit('thread', enr);
  }

  // 2) Exact sender email — enrollment first, then any client.
  if (from) {
    const enr = enrollments.find((e) => normEmail(e.toEmail) === from);
    if (enr) return hit('email', enr);
    const cl = clients.find((c) => normEmail(c.email) === from || (c.contacts || []).some((k) => normEmail(k.email) === from));
    if (cl) return { matched: true, matchBy: 'email', companyKey: cl.companyKey || '', companyName: cl.companyName || '', enrollmentId: '' };
  }

  // 3) Subject still carrying our campaign subject. A subject match is STRONG
  //    (auto-warms), so only act when it resolves to a SINGLE company — a generic,
  //    non-personalized subject ("Quick question") can match enrollments for two
  //    different shops on a shared host; picking the first would warm/stop the
  //    wrong one. Ambiguous (≥2 distinct companyKeys) → leave for manual triage.
  const subj = normSubject(subject);
  if (subj) {
    const matches = enrollments.filter((e) => (e.subjects || []).some((x) => normSubject(x) && normSubject(x) === subj));
    const keys = new Set(matches.map((e) => e.companyKey || '').filter(Boolean));
    if (matches.length && keys.size <= 1) return hit('subject', matches[0]);
  }

  // 4) Domain fallback (soft) — a buyer replying from a personal/shared inbox on
  //    the same business domain. Skipped for freemail so it can't over-match.
  const dom = domainOf(from);
  if (dom && !FREEMAIL.has(dom)) {
    const enr = enrollments.find((e) => domainOf(e.toEmail) === dom);
    if (enr) return hit('domain', enr);
  }

  return { matched: false, matchBy: 'none', companyKey: '', companyName: '', enrollmentId: '' };
}

// ── Follow-Up Command Center (Release 2) ────────────────────────────────────────

// Categories that represent a real human reply the owner should act on (i.e. not
// a bounce, an OOO auto-reply, an unsubscribe, or a clear "no"). Used to build
// the "needs a response" worklist bucket.
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
// (do-not-contact / not-interested / ignored / handled / OOO drop out — done or
// auto-handled.)
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

// ── Gmail sync ───────────────────────────────────────────────────────────────

// Parse an RFC 5322 From header ("Sam Rivera <sam@shop.com>" or "sam@shop.com")
// into { email, name }. PURE — the network fetch lives in the controller.
function parseFromHeader(from) {
  const s = String(from || '').trim();
  const m = s.match(/<([^>]+)>/);
  const email = (m ? m[1] : s).trim().toLowerCase();
  let name = m ? s.slice(0, m.index).trim() : '';
  name = name.replace(/^"(.*)"$/, '$1').trim();
  return { email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '', name };
}

// The Gmail search query for inbound replies to pull: recent, not our own
// outbound, not chats, primary inbox. Deduped downstream by gmailMessageId, so
// re-scanning the window each tick is safe. PURE.
function gmailQuery({ windowDays = 7 } = {}) {
  return `newer_than:${Math.max(1, Math.round(windowDays))}d -from:me -in:chats`;
}

// Reports whether a read-only Gmail sync CAN run (creds present + enabled).
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
  headerSaysAuto,
  isVendorNoiseSender,
  VENDOR_NOISE_DOMAINS,
  looksPromotional,
  finalizeCategory,
  classifyBounceNdr,
  parseOooResume,
  parseFromHeader,
  gmailQuery,
  matchReply,
  normEmail,
  normSubject,
  domainOf,
  stripAngles,
  FREEMAIL,
  STRONG_MATCHES,
  isGmailConfigured,
  worklistFromReplies,
  ACTIONABLE_CATEGORIES,
  HOT_CATEGORIES,
};
