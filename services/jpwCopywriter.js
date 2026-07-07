// services/jpwCopywriter.js
//
// Writes the whole copy for a JP Webworks client site from a plain-language
// brief (the client's email / notes / a short description + services), so the
// owner never has to hand-type a site's words. He pastes what he knows about
// the client, clicks "Generate," and this fills the builder's `data` blob.
//
// Built the same way as services/receiptScanner.js — the ONE Anthropic
// integration this app has:
//   • lazy require('@anthropic-ai/sdk') so the server boots with no key
//   • new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 4 })
//   • isConfigured() = !!ANTHROPIC_API_KEY (feature-flagged; no key → 400)
//   • model from an env var with a default
//
// Uses forced tool-use for structured output (the same trick receiptScanner
// uses): the model MUST call write_site_copy, so we get a clean object instead
// of brittle JSON-in-prose. sanitizeGeneratedData() then coerces that object
// onto the exact site `data` contract and — the honesty guardrail — strips any
// contact detail / price / year / license / review the brief didn't actually
// supply, so a generated site never publishes a fabricated fact.

// Sonnet 5 — good marketing copy, cheap (a few cents a site). Env-overridable.
const MODEL = process.env.JPW_COPY_MODEL || 'claude-sonnet-5';
const MAX_BRIEF = 6000;              // cap the pasted brief (chars) to bound cost
const MAX_SERVICES = 6;
const MAX_TESTIMONIALS = 6;
const MAX_HOURS = 10;

// The tones the dialog offers (mirrors the frontend select). '' = let the
// template's vibe decide.
const TONES = ['Friendly', 'Professional', 'Bold'];

// Each template renders a distinct feel — tell the model which one it's writing
// for so the words match the design. Mirrors the 5 templates in
// website-frontend/src/webworks/templates.
const TEMPLATE_VIBES = {
  trades:       'confident and no-nonsense — a skilled local tradesperson who shows up on time and does it right the first time',
  dining:       'warm and appetite-forward — inviting, a little sensory, the kind of neighborhood spot people come back to',
  wellness:     'calm, elegant, and reassuring — unhurried, caring, and grounded',
  professional: 'trustworthy and precise — clear, credible, and competent without being stiff or corporate',
  retail:       'fun, friendly, and energetic — lively and welcoming, with real personality',
};
const DEFAULT_VIBE = 'friendly, clear, and genuinely trustworthy';

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

// ── The one tool we force the model to call — guarantees clean structured
// output shaped like the site `data` contract's copy fields. ────────────────
const SITE_COPY_TOOL = {
  name: 'write_site_copy',
  description: 'Return the finished one-page website copy for this small local business, grounded strictly in the brief. Call this exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      tagline:      { type: 'string', description: 'One short line under the business name — plain and specific, e.g. "Honest plumbing, done right the first time".' },
      heroHeadline: { type: 'string', description: 'The big headline at the top of the page. Concrete and welcoming; not a slogan full of buzzwords.' },
      ctaLabel:     { type: 'string', description: 'The main call-to-action button label, e.g. "Call for a free estimate" or "Book a table".' },
      serviceArea:  { type: 'string', description: 'The towns / region served, if the brief mentions one, e.g. "Burlington County & nearby". Empty if the brief does not say.' },
      phone:        { type: 'string', description: 'The phone number ONLY IF the brief states one. If the brief has no phone, return an empty string — never invent one.' },
      email:        { type: 'string', description: 'The email address ONLY IF the brief states one. Empty string otherwise — never invent one.' },
      address:      { type: 'string', description: 'The street address ONLY IF the brief states one. Empty string otherwise — never invent one.' },
      established:  { type: 'string', description: 'The founding year ONLY IF the brief states one (e.g. "2012"). Empty string otherwise — never invent a year.' },
      license:      { type: 'string', description: 'A license / credential ONLY IF the brief states one (e.g. "NJ Lic. #1234"). Empty string otherwise — never invent one.' },
      about:        { type: 'string', description: '2–4 honest sentences about the business, in the owner\'s voice. Grounded in the brief.' },
      hours: {
        type: 'array',
        description: 'Business hours. Use the brief\'s hours if given, otherwise a single sensible Mon–Fri row.',
        items: {
          type: 'object',
          properties: {
            days:  { type: 'string', description: 'e.g. "Mon – Fri" or "Sat".' },
            hours: { type: 'string', description: 'e.g. "9:00 AM – 5:00 PM" or "By appointment".' },
          },
          required: ['days', 'hours'],
        },
      },
      services: {
        type: 'array',
        description: '4–6 services this business offers, each with a short, concrete description.',
        items: {
          type: 'object',
          properties: {
            name:  { type: 'string', description: 'The service name, e.g. "Drain cleaning".' },
            desc:  { type: 'string', description: 'One or two concrete sentences on what it is / includes.' },
            price: { type: 'string', description: 'A price ONLY IF the brief implies one (e.g. "from $95"). Empty string otherwise — never invent a price.' },
          },
          required: ['name', 'desc'],
        },
      },
      testimonials: {
        type: 'array',
        description: 'ONLY real customer quotes that appear in the brief, each with the real customer name. If the brief has no real reviews with names, return an empty array. NEVER fabricate a review.',
        items: {
          type: 'object',
          properties: {
            quote: { type: 'string', description: 'The customer\'s words.' },
            name:  { type: 'string', description: 'The real customer\'s name from the brief.' },
          },
          required: ['quote', 'name'],
        },
      },
    },
    required: ['tagline', 'heroHeadline', 'ctaLabel', 'about', 'services', 'hours', 'testimonials'],
  },
};

const SYSTEM = [
  "You write the words for a small local business's one-page website. Your copy is what the owner publishes, so it has to sound like a real person who runs the place — plain, warm, specific, and honest.",
  '',
  'VOICE',
  "- Write for the business's actual customers. Short, concrete sentences. Say what they do and why someone would call them.",
  '- No corporate filler and no AI-slop. Never use words like "unlock", "elevate", "seamless", "empower", "solutions", "cutting-edge", "passionate about", "nestled", "boasts". No pile-ups of em-dashes.',
  '- Be specific to THIS business and its trade — never generic boilerplate that could be any company.',
  '',
  'HONESTY — this is a hard rule; the business\'s reputation rides on it:',
  '- Ground every word in the brief. Invent NO facts.',
  '- Do NOT make up a phone number, email address, street address, price, founding year, or license number. If the brief does not give one, return an empty string for that field.',
  '- A service may carry a price ONLY if the brief implies one; otherwise leave the price empty.',
  '- TESTIMONIALS: include a quote only if the brief contains a real customer quote WITH a real name. If it does not, return an empty testimonials array. Never write a fake review.',
  '',
  'CONTENT',
  '- 4–6 services, each with a short, concrete description of what it actually is.',
  '- An hours list: use the brief\'s hours if it gives them, otherwise a single sensible "Mon – Fri" row.',
  '- A 2–4 sentence About section in the owner\'s voice.',
  '- A tagline, a hero headline, and a short call-to-action label.',
  '',
  'Return your answer by calling the write_site_copy tool exactly once.',
].join('\n');

// PURE — build the user prompt. Exported for unit tests. `brief` is expected to
// already be capped by the caller.
function buildCopyPrompt({ businessName, businessType, templateId, brief, tone } = {}) {
  const name = String(businessName || 'this business').trim() || 'this business';
  const type = String(businessType || '').trim();
  const tpl = String(templateId || '').trim();
  const vibe = TEMPLATE_VIBES[tpl] || DEFAULT_VIBE;
  const t = TONES.includes(tone) ? tone : '';
  const toneLine = t
    ? ` The owner wants an overall ${t.toLowerCase()} tone — let that guide the wording.`
    : '';
  const typeLine = type ? `, a ${type} business` : '';

  return [
    `The business is "${name}"${typeLine}.`,
    `This site uses the "${tpl || 'default'}" template, so write in a tone that is ${vibe}.${toneLine}`,
    '',
    'Here is everything the owner told me about the business. Base the copy entirely on this — do not add any fact it does not contain:',
    '',
    '"""',
    String(brief || '').trim(),
    '"""',
    '',
    'Write the full site copy now and return it by calling write_site_copy.',
  ].join('\n');
}

// ── Sanitizers / brief-presence detectors (PURE, unit-tested) ────────────────
const trimStr = (v) => (typeof v === 'string' ? v.trim() : '');

// Does the brief actually contain a given kind of fact? These gate whether we
// keep the model's value — the safety net behind the prompt's honesty rules, so
// even a hallucinated phone/price/year/review can never reach a published site.
function briefHasEmail(b)   { return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(String(b)); }
function briefHasPhone(b)   { return /(?:\(?\d{3}\)?[\s.\-]?)?\d{3}[\s.\-]?\d{4}/.test(String(b)); }
function briefHasYear(b)    { return /\b(?:19|20)\d{2}\b/.test(String(b)); }
function briefHasLicense(b) { return /licen|\blic[.#]|\blic\s*(?:no|number|#)|certif|permit\s*#/i.test(String(b)); }
function briefHasAddress(b) {
  const s = String(b);
  const street = /\d{1,6}\s+[\w.'-]+(?:\s+[\w.'-]+)*\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|ct|court|pl|place|hwy|highway|pkwy|parkway|ste|suite|unit)\b/i;
  const zip = /\b\d{5}(?:-\d{4})?\b/;
  return street.test(s) || zip.test(s);
}
function briefHasMoney(b) {
  return /\$\s?\d|\b\d+\s*(?:dollars?|usd|bucks)\b|\bprices?\b|\bcosts?\b|\bfees?\b|\brates?\b|\bstarting at\b/i.test(String(b));
}

function sanitizeHours(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => ({ days: trimStr(r && r.days), hours: trimStr(r && r.hours) }))
    .filter((r) => r.days || r.hours)
    .slice(0, MAX_HOURS);
}

function sanitizeServices(v, allowPrice) {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => {
      const name = trimStr(s && s.name);
      const desc = trimStr(s && s.desc);
      const price = allowPrice ? trimStr(s && s.price) : '';
      return price ? { name, desc, price } : { name, desc };
    })
    .filter((s) => s.name)          // a service without a name is noise
    .slice(0, MAX_SERVICES);
}

function sanitizeTestimonials(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((q) => ({ quote: trimStr(q && q.quote), name: trimStr(q && q.name) }))
    // Honesty rule: only a quote WITH a real name survives — no name, no review.
    .filter((q) => q.quote && q.name)
    .slice(0, MAX_TESTIMONIALS);
}

// Coerce whatever the model returned into the EXACT site `data` copy contract:
// drop unknown keys, force arrays, and strip any fabricated contact detail /
// price / year / license / review that the brief did not actually supply. The
// contact/factual fields are OMITTED (not blanked) when the brief lacks them,
// so a merge into the live draft never clobbers a value the owner already typed.
function sanitizeGeneratedData(raw, brief = '') {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const b = String(brief || '');

  const out = {
    tagline:      trimStr(r.tagline),
    heroHeadline: trimStr(r.heroHeadline),
    ctaLabel:     trimStr(r.ctaLabel),
    serviceArea:  trimStr(r.serviceArea),
    about:        trimStr(r.about),
    hours:        sanitizeHours(r.hours),
    services:     sanitizeServices(r.services, briefHasMoney(b)),
    testimonials: sanitizeTestimonials(r.testimonials),
  };

  // Gated facts — kept ONLY when the brief itself supplies that kind of detail.
  const phone = trimStr(r.phone);
  if (phone && briefHasPhone(b)) out.phone = phone;
  const email = trimStr(r.email);
  if (email && briefHasEmail(b)) out.email = email;
  const address = trimStr(r.address);
  if (address && briefHasAddress(b)) out.address = address;
  const established = trimStr(r.established);
  if (established && briefHasYear(b)) out.established = established;
  const license = trimStr(r.license);
  if (license && briefHasLicense(b)) out.license = license;

  return out;
}

// What the owner still has to supply by hand after a generate (we never invent
// reviews or photos, and can't dial a phone the brief didn't give us).
function computeNeeds(data) {
  const d = data || {};
  const needs = [];
  if (!Array.isArray(d.testimonials) || d.testimonials.length === 0) needs.push('testimonials');
  if (!d.phone && !d.email) needs.push('contact info');
  needs.push('photos');
  return needs;
}

// Turn any SDK/model error into a short, owner-friendly line. Never leak stack
// traces or raw API errors to the Studio.
function cleanError(e) {
  const status = e && e.status;
  if (status === 429 || (e && e.name === 'RateLimitError')) {
    return 'The AI is busy right now — give it a few seconds and try again.';
  }
  if (status === 529 || status === 503 || status === 500) {
    return 'The AI service is temporarily unavailable — try again in a moment.';
  }
  if (status === 401 || status === 403) {
    return 'The AI copywriting key was rejected — check ANTHROPIC_API_KEY on the API.';
  }
  return (e && e.message) ? `Couldn't write the site: ${e.message}` : "Couldn't write the site — please try again.";
}

// Generate the site's copy from the brief. NEVER throws — on any model/SDK
// failure it returns { error } that the controller turns into a 502. On success
// returns { data: <copy fields>, meta: { model, needs } }.
async function generateSiteCopy({ businessName, businessType, templateId, brief, tone } = {}) {
  const capped = String(brief || '').slice(0, MAX_BRIEF);
  const prompt = buildCopyPrompt({ businessName, businessType, templateId, brief: capped, tone });
  try {
    const msg = await _getClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      // Structured, deterministic, cheap: force the tool and keep thinking off
      // (Sonnet 5 defaults thinking ON, which both costs more and conflicts with
      // a forced tool_choice).
      thinking: { type: 'disabled' },
      tools: [SITE_COPY_TOOL],
      tool_choice: { type: 'tool', name: SITE_COPY_TOOL.name },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    const tool = (msg.content || []).find((blk) => blk.type === 'tool_use');
    if (!tool) return { error: "The AI didn't return any site copy — try again." };
    const data = sanitizeGeneratedData(tool.input || {}, capped);
    return { data, meta: { model: MODEL, needs: computeNeeds(data) } };
  } catch (e) {
    return { error: cleanError(e) };
  }
}

module.exports = {
  isConfigured, generateSiteCopy,
  // pure helpers (unit-tested) + constants
  buildCopyPrompt, sanitizeGeneratedData, computeNeeds,
  briefHasEmail, briefHasPhone, briefHasAddress, briefHasYear, briefHasLicense, briefHasMoney,
  SITE_COPY_TOOL, TEMPLATE_VIBES, TONES, MODEL,
};
