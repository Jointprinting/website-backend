// services/outreachCopy.js
//
// AI drafting for the Outreach pipeline — the two writing jobs the owner still
// does from scratch:
//
//   draftReply({ reply, client, orders })      → a suggested response to a warm
//       lead's reply (the Replies worklist). Plain text, ready to paste/edit.
//   draftSequence({ vertical, touches, notes }) → a cold-email sequence the
//       campaign editor pre-fills FOR REVIEW.
//
// Owner decision: AI DRAFTS, OWNER SENDS. Nothing in here (or in the endpoints
// that call it) sends mail — a draft is text the owner edits and fires himself.
//
// Built the same way as services/jpwCopywriter.js (the other Anthropic copy
// integration):
//   • lazy require('@anthropic-ai/sdk') so the server boots with no key
//   • isConfigured() = !!ANTHROPIC_API_KEY (feature-flagged; no key → 400)
//   • model from an env var with a default
//   • forced tool-use for structured output, sanitized defensively after
// Budget guardrails (services/aiBudget.js preflight/recordUsage) are applied by
// the controller around each call, exactly like controllers/jpwSites.js.

// Sonnet 5 — good sales copy, cheap (fractions of a cent a draft). Env-overridable.
const MODEL = process.env.OUTREACH_COPY_MODEL || 'claude-sonnet-5';

const MAX_SNIPPET = 2000;      // cap the reply snippet fed to the model (chars)
const MAX_NOTES = 2000;        // cap the owner's sequence notes (chars)
const MAX_REPLY_CHARS = 2000;  // hard ceiling on a returned reply draft
const MAX_STEP_CHARS = 2500;   // hard ceiling per sequence subject/body
const DEFAULT_TOUCHES = 4;
const MAX_TOUCHES = 6;
// The escalating cadence when the model returns junk offsets: touch 1 now, then
// +3 / +7 / +14 days (mirrors the approved DEFAULT_SEQUENCE ladder — each value
// is days AFTER THE PREVIOUS email, the engine's offsetDays semantics).
const DEFAULT_OFFSETS = [0, 3, 7, 14];

// ── Merge vocabulary ─────────────────────────────────────────────────────────
// EXACTLY the fields buildMergeContext (services/outreachEngine.js) renders —
// the only tokens the sender resolves. Sync-pinned by a unit test; a token
// outside this set would render as its fallback (or '') on every send.
const KNOWN_MERGE_FIELDS = ['companyName', 'clientName', 'firstName', 'greeting', 'city', 'state', 'senderName'];

// Near-miss spellings the model might emit — rewritten onto the real token so a
// sentence never silently loses its subject.
const MERGE_ALIASES = {
  company: 'companyName',
  firstname: 'firstName',
  first_name: 'firstName',
};

// Same token grammar as renderTemplate (services/outreachEngine.js):
// {{field}} / {{field|fallback}}.
const MERGE_TOKEN_RE = /\{\{\s*([A-Za-z][\w]*)\s*(?:\|([^}]*))?\}\}/g;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let _client = null;
function _getClient() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk'); // lazy: server boots without a key
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });
  return _client;
}

const trimStr = (v) => (typeof v === 'string' ? v.trim() : '');

// ── PURE sanitizers (unit-tested in services/__tests__/outreachCopy.test.js) ──

// Keep known merge tokens verbatim, rewrite aliased near-misses onto the real
// token, and resolve anything else to its fallback (or drop it) — the exact
// value renderTemplate would produce at send time, so the owner's preview never
// disagrees with the send. `stripAll` resolves EVERY token (used for reply
// drafts, which go to a real person and must carry no template braces).
function sanitizeMergeTokens(text, { stripAll = false } = {}) {
  return String(text || '').replace(MERGE_TOKEN_RE, (match, key, fallback) => {
    if (!stripAll) {
      if (KNOWN_MERGE_FIELDS.includes(key)) return match;
      const alias = MERGE_ALIASES[key];
      if (alias) return fallback != null ? `{{${alias}|${fallback}}}` : `{{${alias}}}`;
    }
    return String(fallback || '').trim();
  });
}

// Coerce the model's reply output into safe plain text: string only, no
// "Subject:" line (it's a reply — the thread already has one), no merge tokens
// (it goes to a real person), bounded length.
function sanitizeReplyBody(raw) {
  let body = trimStr(raw && typeof raw === 'object' ? raw.body : raw);
  body = body.replace(/^subject\s*:.*\n+/i, '');       // defensive: drop a stray subject line
  body = sanitizeMergeTokens(body, { stripAll: true }).trim();
  return body.slice(0, MAX_REPLY_CHARS);
}

// Coerce the model's sequence output onto the campaign-step contract the editor
// and sanitizeSteps (controllers/outreach.js) expect:
//   [{ subject, body, offsetDays }]  — offsetDays = days after the PREVIOUS email.
// Steps without a body are dropped; offsets are forced onto a sane escalating
// ladder (first sends now; later ones positive, defaulting to 0/3/7/14).
function sanitizeSequenceSteps(raw, touches = DEFAULT_TOUCHES) {
  const want = Math.min(MAX_TOUCHES, Math.max(2, Math.round(Number(touches) || DEFAULT_TOUCHES)));
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.steps) ? raw.steps : []);
  return arr
    .map((s) => ({
      subject: sanitizeMergeTokens(trimStr(s && s.subject)).slice(0, MAX_STEP_CHARS),
      body: sanitizeMergeTokens(trimStr(s && s.body)).slice(0, MAX_STEP_CHARS),
      offsetDays: Number(s && s.offsetDays),
    }))
    .filter((s) => s.body)          // a step without a body is noise
    .slice(0, want)
    .map((s, i) => ({
      ...s,
      offsetDays: i === 0
        ? 0
        : (Number.isFinite(s.offsetDays) && s.offsetDays >= 1
          ? Math.round(s.offsetDays)
          : (DEFAULT_OFFSETS[i] != null ? DEFAULT_OFFSETS[i] : DEFAULT_OFFSETS[DEFAULT_OFFSETS.length - 1])),
    }));
}

// ── Shared voice (the business facts the model may state — nothing else) ─────
const VOICE = [
  'VOICE — this is Nate, the owner of Joint Printing, writing himself:',
  '- Joint Printing is a custom-merch studio: "we\'re your merch department, not just a printer." Screen printing, embroidery, promo products — staff tees/hoodies, hats, counter stuff like lighters and grinders.',
  '- Primary customers are cannabis dispensaries; the same plain voice works for any shop.',
  '- Short, concrete sentences that read like a real person typed them in thirty seconds. No corporate filler, no AI-slop: never "unlock", "elevate", "seamless", "empower", "solutions", "cutting-edge", "passionate about", "circle back on synergies". No numbered ask-lists, no exclamation pile-ups.',
  '- Facts you may use (never invent others, and NEVER invent a price): free mockups made from their logo (~3-day turnaround, no commitment); most orders are 50+ units per design; ~3-4 weeks from approved mockup + payment; site is jointprinting.com.',
  '- Sign off as "Nate" on its own line. Plain text only — no markdown, no bullet formatting.',
].join('\n');

// ── Reply drafting ───────────────────────────────────────────────────────────

const REPLY_TOOL = {
  name: 'write_reply',
  description: "Return the suggested email reply's plain-text body. Call this exactly once.",
  input_schema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'The reply body — plain text, under 180 words, no subject line, signed "Nate".' },
    },
    required: ['body'],
  },
};

const REPLY_SYSTEM = [
  'You draft the reply Nate sends to a buyer who answered his cold outreach. Nate reads, edits, and sends it HIMSELF — you only suggest the words, so never mention AI, drafting, or that this was generated.',
  '',
  VOICE,
  '',
  'RULES',
  '- Under 180 words. No subject line — this is a reply in an existing thread.',
  '- Answer what THEY said. Move it one concrete step forward: a question they can answer in one line (logo? quantities? which products?), or an easy yes.',
  '- If they asked pricing: do not quote numbers — ask the one or two details needed to price it (quantity, product, print locations) and offer the free mockups meanwhile.',
  '- If they asked for mockups: ask for their logo and what they want to see it on; say the mockups are free and take about 3 days.',
  '- If it went to the wrong person: thank them and ask who handles merch.',
  '- Use the real company/contact name given in the context — never a placeholder or {{merge}} token.',
  '- Ground every claim in the context and the facts above. Invent nothing.',
  '',
  'Return the reply by calling write_reply exactly once.',
].join('\n');

// PURE — build the reply prompt from the triage row + CRM context. Exported for
// unit tests. Only plain fields go in; snippets are capped by the caller.
function buildReplyPrompt({ reply = {}, client = null, orders = [] } = {}) {
  const r = reply || {};
  const c = client || {};
  const placed = Array.isArray(orders) ? orders.length : 0;
  const lines = [
    'A buyer replied to our cold outreach. Draft the response.',
    '',
    'THEIR REPLY',
    `- From: ${trimStr(r.fromName) || '(no name)'} <${trimStr(r.fromEmail) || 'unknown'}>`,
    `- Subject: ${trimStr(r.subject) || '(no subject)'}`,
    `- What they wrote: """${String(r.snippet || '').slice(0, MAX_SNIPPET).trim() || '(no snippet captured)'}"""`,
    `- Classified as: ${trimStr(r.category) || 'needs_response'}${r.suggestedAction ? ` (${r.suggestedAction})` : ''}`,
    '',
    'WHAT WE KNOW ABOUT THEM (CRM)',
    `- Company: ${trimStr(c.companyName) || trimStr(r.companyName) || 'unknown'}`,
    `- Contact: ${trimStr(c.clientName) || trimStr(r.fromName) || 'unknown'}`,
    `- Pipeline stage: ${trimStr(c.stage) || 'lead'}`,
    `- Last contact: ${c.lastContact ? new Date(c.lastContact).toISOString().slice(0, 10) : 'never (cold)'}`,
    `- Order history: ${placed > 0 ? `existing customer — ${placed} placed order${placed === 1 ? '' : 's'}` : 'no orders yet (prospect)'}`,
    '',
    'Write the reply now and return it by calling write_reply.',
  ];
  return lines.join('\n');
}

// Draft a reply to one triaged buyer reply. NEVER throws — a model/SDK failure
// returns { error } the controller turns into a 502. On success returns
// { body, meta: { model, usage } }; the controller records `usage` against the
// AI budget (services/aiBudget.js) and persists the draft on the TriageReply.
async function draftReply({ reply, client, orders } = {}) {
  const prompt = buildReplyPrompt({ reply, client, orders });
  try {
    const msg = await _getClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: REPLY_SYSTEM,
      // Structured, deterministic, cheap: force the tool and keep thinking off
      // (Sonnet 5 defaults thinking ON, which both costs more and conflicts with
      // a forced tool_choice). Same setup as jpwCopywriter.
      thinking: { type: 'disabled' },
      tools: [REPLY_TOOL],
      tool_choice: { type: 'tool', name: REPLY_TOOL.name },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    const tool = (msg.content || []).find((blk) => blk.type === 'tool_use');
    const body = sanitizeReplyBody(tool && tool.input);
    if (!body) return { error: "The AI didn't return a draft — try again." };
    const usage = msg.usage
      ? { input_tokens: msg.usage.input_tokens || 0, output_tokens: msg.usage.output_tokens || 0 }
      : null;
    return { body, meta: { model: MODEL, usage } };
  } catch (e) {
    return { error: cleanError(e) };
  }
}

// ── Sequence drafting ────────────────────────────────────────────────────────

const SEQUENCE_TOOL = {
  name: 'write_sequence',
  description: 'Return the cold-email sequence as ordered steps. Call this exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'The touches in send order.',
        items: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Subject line — short, lowercase-leaning, under ~50 chars. Merge tokens allowed.' },
            body: { type: 'string', description: 'Plain-text body, under ~120 words, opening with {{greeting}} and signed "Nate".' },
            offsetDays: { type: 'integer', description: 'Days AFTER THE PREVIOUS email (0 for the first touch, e.g. 0, 3, 7, 14).' },
          },
          required: ['subject', 'body', 'offsetDays'],
        },
      },
    },
    required: ['steps'],
  },
};

const SEQUENCE_SYSTEM = [
  'You draft a cold-email sequence for Joint Printing. The owner reviews and edits every word in the campaign editor before anything is activated — you draft, he decides.',
  '',
  VOICE,
  '',
  'MERGE TOKENS — the sender resolves ONLY these; write {{field}} or {{field|fallback}} and use no other tokens:',
  '- {{greeting}} — smart opener: "Hey Sam," when a first name is known, plain "Hey," when not. Open every body with it.',
  '- {{firstName}} — contact first name (often blank for scraped shops; always give a fallback or prefer {{greeting}}).',
  '- {{companyName}} — the shop name. Use it naturally once or twice per email.',
  '- {{city|your area}} / {{state|NJ}} — parsed from the address; ALWAYS include a fallback with these two.',
  '- {{clientName}} — full contact name. {{senderName}} — who the mail signs off as.',
  '',
  'STRUCTURE — escalate across the touches:',
  '1. Intro — who we are in one line, the free-mockup hook, a soft "worth a look?"',
  '2. Value/proof — bump it up, make starting effortless (logo + a one-line ask is enough), one concrete proof point.',
  '3. Nudge — a different angle (e.g. staff gear first, then a customer drop), still zero-commitment.',
  '4. Breakup — last one, no guilt, door stays open, clean exit.',
  'offsetDays is days after the PREVIOUS email: 0 for touch 1, then an escalating 3, 7, 14 unless told otherwise.',
  '',
  'RULES',
  '- Each body under ~120 words, opening with {{greeting}}, signed "Nate" (touch 1 and the breakup may add "jointprinting.com" under it).',
  '- Subjects short and unstuffy — no ALL CAPS, no !!, no spam-trigger phrasing ("act now", "limited time", "100% free").',
  '- Follow-ups thread as "Re: <touch 1 subject>" automatically, so their subjects are fallbacks — keep them short.',
  '- Never say where we are based. Never invent prices, discounts, or customer names.',
  '',
  'Return the sequence by calling write_sequence exactly once.',
].join('\n');

// PURE — build the sequence prompt. Exported for unit tests.
function buildSequencePrompt({ vertical, touches = DEFAULT_TOUCHES, notes } = {}) {
  const who = trimStr(vertical) || 'cannabis dispensaries';
  const n = Math.min(MAX_TOUCHES, Math.max(2, Math.round(Number(touches) || DEFAULT_TOUCHES)));
  const extra = String(notes || '').slice(0, MAX_NOTES).trim();
  return [
    `Write a ${n}-touch cold-email sequence targeting ${who}.`,
    'Adapt the pitch to what that kind of business actually stocks and cares about, in Joint Printing\'s plain voice.',
    extra ? `\nOwner's notes for this one — fold them in:\n"""${extra}"""` : '',
    '',
    'Write the sequence now and return it by calling write_sequence.',
  ].filter((l) => l !== '').join('\n');
}

// Draft a cold-email sequence. NEVER throws — failures return { error }. On
// success returns { steps, meta: { model, usage } }; steps are already coerced
// onto the campaign-step contract (see sanitizeSequenceSteps).
async function draftSequence({ vertical, touches = DEFAULT_TOUCHES, notes } = {}) {
  const prompt = buildSequencePrompt({ vertical, touches, notes });
  try {
    const msg = await _getClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SEQUENCE_SYSTEM,
      thinking: { type: 'disabled' },
      tools: [SEQUENCE_TOOL],
      tool_choice: { type: 'tool', name: SEQUENCE_TOOL.name },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    const tool = (msg.content || []).find((blk) => blk.type === 'tool_use');
    const steps = sanitizeSequenceSteps(tool && tool.input, touches);
    if (!steps.length) return { error: "The AI didn't return any steps — try again." };
    const usage = msg.usage
      ? { input_tokens: msg.usage.input_tokens || 0, output_tokens: msg.usage.output_tokens || 0 }
      : null;
    return { steps, meta: { model: MODEL, usage } };
  } catch (e) {
    return { error: cleanError(e) };
  }
}

// Turn any SDK/model error into a short, owner-friendly line — same mapping as
// jpwCopywriter.cleanError. Never leak stack traces or raw API errors.
function cleanError(e) {
  const status = e && e.status;
  if (status === 429 || (e && e.name === 'RateLimitError')) {
    return 'The AI is busy right now — give it a few seconds and try again.';
  }
  if (status === 529 || status === 503 || status === 500) {
    return 'The AI service is temporarily unavailable — try again in a moment.';
  }
  if (status === 401 || status === 403) {
    return 'The AI drafting key was rejected — check ANTHROPIC_API_KEY on the API.';
  }
  return (e && e.message) ? `Couldn't draft it: ${e.message}` : "Couldn't draft it — please try again.";
}

module.exports = {
  isConfigured, draftReply, draftSequence,
  // pure helpers (unit-tested) + constants
  buildReplyPrompt, buildSequencePrompt,
  sanitizeReplyBody, sanitizeSequenceSteps, sanitizeMergeTokens,
  KNOWN_MERGE_FIELDS, MERGE_ALIASES, DEFAULT_OFFSETS, DEFAULT_TOUCHES, MAX_TOUCHES,
  REPLY_TOOL, SEQUENCE_TOOL, MODEL,
};
