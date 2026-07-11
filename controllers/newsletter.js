// controllers/newsletter.js
//
// The Studio's client newsletter — compose → pick audience → send from a
// dedicated identity → track opens/replies. Model: models/Newsletter.js.
//
// DELIVERABILITY BY DESIGN: sends only when NEWSLETTER_EMAIL_FROM is set (a
// separate domain, e.g. jointprintingshop.com), never the main transactional
// EMAIL_FROM — so a warm blast to the whole client list can't dent the inbox
// that carries invoices and approvals. Replies point back to the main inbox
// (REPLY_TO / EMAIL_FROM) so they land in the triage flow and are visible.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const Newsletter = require('../models/Newsletter');
const Client = require('../models/Client');
const TriageReply = require('../models/TriageReply');
const r2 = require('../services/r2');

const PUBLIC_BASE = String(process.env.OUTREACH_PUBLIC_API_BASE || process.env.PUBLIC_API_BASE || '').replace(/\/+$/, '');

// The newsletter transport: its OWN SMTP when configured (NEWSLETTER_SMTP_*),
// else the shared global SMTP_* — but always FROM the newsletter identity.
let _transport = null;
function transport() {
  if (_transport) return _transport;
  const host = process.env.NEWSLETTER_SMTP_HOST || process.env.SMTP_HOST;
  const port = Number(process.env.NEWSLETTER_SMTP_PORT || process.env.SMTP_PORT) || 465;
  const user = process.env.NEWSLETTER_SMTP_USER || process.env.SMTP_USER;
  const pass = process.env.NEWSLETTER_SMTP_PASS || process.env.SMTP_PASS;
  if (!host || !user) return null;
  _transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  return _transport;
}
const fromAddress = () => String(process.env.NEWSLETTER_EMAIL_FROM || '').trim();
const replyTo = () => String(process.env.NEWSLETTER_REPLY_TO || process.env.EMAIL_FROM || '').trim();
const canSend = () => !!(fromAddress() && transport());

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Plain-text body → paragraphs, preserving blank-line breaks. Mirrors the
// outreach engine's text-to-HTML so both read the same.
const bodyToHtml = (text) => {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em 0;line-height:1.6;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
};

const fileIcon = (kind) => kind === 'pdf' ? '📄' : kind === 'image' ? '🖼️' : '📎';

// The branded HTML shell — clean, light, mobile-friendly. Open pixel + file
// buttons + an honest unsubscribe line (we key opt-out off the CRM doNotEmail,
// so the link is a mailto that the owner actions).
function renderHtml(nl, recipient) {
  const pixel = (PUBLIC_BASE && recipient.token)
    ? `<img src="${PUBLIC_BASE}/api/newsletter/t/${recipient.token}/open.png" width="1" height="1" alt="" style="display:none">`
    : '';
  const hero = nl.heroImage
    ? `<img src="${esc(nl.heroImage)}" alt="" style="width:100%;max-width:600px;border-radius:10px;display:block;margin:0 0 20px;">`
    : '';
  const files = (nl.files || []).length ? `
    <div style="margin:22px 0;">
      ${(nl.files || []).map((f) => `
        <a href="${esc(f.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 16px;border-radius:10px;background:#15803d;color:#fff;text-decoration:none;font-weight:700;font-size:14px;">
          ${fileIcon(f.kind)}&nbsp; ${esc(f.filename || 'Download')}
        </a>`).join('')}
    </div>` : '';
  const reply = replyTo();
  return `<!doctype html><html><body style="margin:0;background:#f4f4f1;">
    ${pixel}
    <div style="max-width:600px;margin:0 auto;padding:28px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111a14;">
      <div style="text-align:center;margin-bottom:18px;">
        <span style="font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#15803d;">Joint Printing</span>
      </div>
      <div style="background:#fff;border:1px solid rgba(15,26,19,0.10);border-radius:16px;padding:28px 26px;box-shadow:0 10px 34px rgba(15,26,19,0.06);">
        ${hero}
        ${nl.subject ? `<h1 style="font-size:23px;font-weight:900;margin:0 0 14px;letter-spacing:-0.4px;line-height:1.2;">${esc(nl.subject)}</h1>` : ''}
        ${bodyToHtml(nl.body)}
        ${files}
      </div>
      <div style="text-align:center;color:rgba(17,26,20,0.42);font-size:11.5px;line-height:1.6;margin-top:18px;">
        Joint Printing · your merch department${reply ? ` · <a href="mailto:${esc(reply)}" style="color:#15803d;">reply anytime</a>` : ''}<br>
        ${reply ? `Prefer not to get these? <a href="mailto:${esc(reply)}?subject=Unsubscribe" style="color:rgba(17,26,20,0.42);">Unsubscribe</a>.` : ''}
      </div>
    </div>
  </body></html>`;
}

// ── Audience ────────────────────────────────────────────────────────────────
async function resolveAudience(audience, tag) {
  const q = { doNotEmail: { $ne: true }, archived: { $ne: true } };
  if (audience === 'customers') q.stage = { $in: ['customer', 'won'] };
  else if (audience === 'leads') q.stage = { $in: ['lead', 'contacted', 'quoting', 'awaiting_details'] };
  else if (audience === 'tag' && tag) q.tags = tag;
  const clients = await Client.find(q).select('companyKey companyName clientName email contacts').lean();
  // One recipient per company: the company email, else the first contact email.
  const out = [];
  const seen = new Set();
  for (const c of clients) {
    const email = String(c.email || (c.contacts || []).map((k) => k.email).find(Boolean) || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ companyKey: c.companyKey || '', name: c.companyName || c.clientName || '', email });
  }
  return out;
}

// ── CRUD ────────────────────────────────────────────────────────────────────
function pickEditable(b = {}) {
  const out = {};
  for (const f of ['subject', 'preheader', 'body', 'heroImage']) if (b[f] !== undefined) out[f] = String(b[f] || '');
  if (b.audience !== undefined && ['all', 'customers', 'leads', 'tag'].includes(b.audience)) out.audience = b.audience;
  if (b.audienceTag !== undefined) out.audienceTag = String(b.audienceTag || '').slice(0, 60);
  if (Array.isArray(b.files)) {
    out.files = b.files.filter((f) => f && f.url).slice(0, 10).map((f) => ({
      filename: String(f.filename || 'file').slice(0, 200), url: String(f.url), size: Number(f.size) || 0,
      kind: ['pdf', 'image', 'file'].includes(f.kind) ? f.kind : 'file',
    }));
  }
  return out;
}

const listNewsletters = async (req, res) => {
  try {
    const q = req.query.archived === '1' ? {} : { archived: { $ne: true } };
    const rows = await Newsletter.find(q).sort({ updatedAt: -1 }).limit(100)
      .select('subject status audience audienceTag sentAt recipients.sentAt recipients.openedAt archived archivedAt updatedAt').lean();
    res.json({
      newsletters: rows.map((n) => {
        const recips = n.recipients || [];
        const sent = recips.filter((r) => r.sentAt).length;
        const opened = recips.filter((r) => r.openedAt).length;
        return {
          _id: n._id, subject: n.subject, status: n.status, audience: n.audience, audienceTag: n.audienceTag,
          sentAt: n.sentAt, archived: n.archived, archivedAt: n.archivedAt, updatedAt: n.updatedAt,
          sentCount: sent, openedCount: opened,
        };
      }),
      canSend: canSend(), fromAddress: fromAddress(),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

const createNewsletter = async (req, res) => {
  try {
    const nl = await Newsletter.create({ ...pickEditable(req.body || {}), subject: String((req.body || {}).subject || 'Untitled') });
    res.status(201).json({ newsletter: nl });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

const getNewsletter = async (req, res) => {
  try {
    const nl = await Newsletter.findById(req.params.id).lean();
    if (!nl) return res.status(404).json({ message: 'Not found' });
    // Replies: cross-reference the triage inbox for any recipient who wrote back
    // AFTER their send (decoupled — no write, computed here).
    const stats = await computeStats(nl);
    res.json({ newsletter: nl, stats, canSend: canSend(), fromAddress: fromAddress() });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

const patchNewsletter = async (req, res) => {
  try {
    const current = await Newsletter.findById(req.params.id).select('status archived').lean();
    if (!current) return res.status(404).json({ message: 'Not found' });
    if (current.status === 'sent' || current.status === 'sending') {
      // A sent newsletter is a record — only archive/unarchive may change.
      const set = {};
      if (req.body && req.body.archived !== undefined) {
        set.archived = req.body.archived === true;
        set.archivedAt = set.archived && !current.archived ? new Date() : (set.archived ? undefined : null);
      }
      if (Object.keys(set).length === 0) return res.status(400).json({ message: 'A sent newsletter can only be archived.' });
      const nl = await Newsletter.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
      return res.json({ newsletter: nl });
    }
    const set = pickEditable(req.body || {});
    if (req.body && req.body.archived !== undefined) {
      set.archived = req.body.archived === true;
      set.archivedAt = set.archived ? new Date() : null;
    }
    const nl = await Newsletter.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    res.json({ newsletter: nl });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Upload a file (data URL) → R2 → return the attachment record for the draft.
const uploadFile = async (req, res) => {
  try {
    const { dataUrl, filename } = req.body || {};
    if (!dataUrl || !String(dataUrl).startsWith('data:')) return res.status(400).json({ message: 'Expected a data URL.' });
    const url = await r2.uploadDataUrl(dataUrl, 'newsletter');
    const mime = (String(dataUrl).match(/^data:([^;]+)/) || [])[1] || '';
    const kind = /pdf/.test(mime) ? 'pdf' : /^image\//.test(mime) ? 'image' : 'file';
    const size = Math.round((String(dataUrl).length - String(dataUrl).indexOf(',')) * 0.75);
    res.json({ file: { filename: String(filename || 'file').slice(0, 200), url, size, kind } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Preview the audience size before sending (no send).
const previewAudience = async (req, res) => {
  try {
    const nl = await Newsletter.findById(req.params.id).lean();
    if (!nl) return res.status(404).json({ message: 'Not found' });
    const recips = await resolveAudience(nl.audience, nl.audienceTag);
    res.json({ count: recips.length, sample: recips.slice(0, 8).map((r) => r.name || r.email) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Send one test to a chosen address (does not touch the recipient list/status).
const sendTest = async (req, res) => {
  try {
    if (!canSend()) return res.status(400).json({ message: 'Set NEWSLETTER_EMAIL_FROM (a separate sending domain) + SMTP on the API first.' });
    const nl = await Newsletter.findById(req.params.id).lean();
    if (!nl) return res.status(404).json({ message: 'Not found' });
    const to = String((req.body || {}).to || replyTo() || '').trim();
    if (!to) return res.status(400).json({ message: 'No test address.' });
    const recipient = { name: 'Test', email: to, token: '' };
    await transport().sendMail({
      from: fromAddress(), to, replyTo: replyTo() || undefined,
      subject: `[TEST] ${nl.subject}`,
      html: renderHtml(nl, recipient),
      headers: nl.preheader ? { 'X-Preheader': nl.preheader } : undefined,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Send to the whole audience. Paced in small batches with a short pause so a
// new sending domain isn't a firehose. Idempotent per newsletter: refuses to
// re-send an already-sent one.
const sendNewsletter = async (req, res) => {
  try {
    if (!canSend()) return res.status(400).json({ message: 'Set NEWSLETTER_EMAIL_FROM (a separate sending domain) + SMTP on the API first.' });
    const nl = await Newsletter.findById(req.params.id);
    if (!nl) return res.status(404).json({ message: 'Not found' });
    if (nl.status === 'sent' || nl.status === 'sending') return res.status(400).json({ message: 'Already sent.' });
    if (!nl.subject || !nl.body) return res.status(400).json({ message: 'Add a subject and body first.' });

    const audience = await resolveAudience(nl.audience, nl.audienceTag);
    if (!audience.length) return res.status(400).json({ message: 'No emailable clients in this audience.' });

    nl.recipients = audience.map((a) => ({ ...a, token: crypto.randomBytes(16).toString('hex'), sentAt: null }));
    nl.status = 'sending';
    await nl.save();

    // Respond immediately; the blast runs in the background so the request can't
    // time out on a big list. Progress shows on the newsletter's stats.
    res.json({ ok: true, sending: nl.recipients.length });

    (async () => {
      const t = transport();
      let sent = 0;
      for (const r of nl.recipients) {
        try {
          await t.sendMail({
            from: fromAddress(), to: r.email, replyTo: replyTo() || undefined,
            subject: nl.subject, html: renderHtml(nl, r),
            headers: nl.preheader ? { 'X-Preheader': nl.preheader } : undefined,
          });
          r.sentAt = new Date(); sent += 1;
        } catch (err) {
          r.failed = true; r.error = String(err.message || 'send failed').slice(0, 200);
        }
        // Persist progress + pace every few sends.
        if (sent % 5 === 0) { await nl.save().catch(() => {}); await new Promise((rs) => setTimeout(rs, 1500)); }
      }
      nl.status = nl.recipients.some((r) => r.sentAt) ? 'sent' : 'failed';
      nl.sentAt = new Date();
      await nl.save().catch(() => {});
    })().catch(() => {});
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Open pixel — 1×1 transparent PNG, never 404s to the mail client.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const openPixel = async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (token) {
      await Newsletter.updateOne(
        { 'recipients.token': token },
        { $set: { 'recipients.$.openedAt': new Date() }, $inc: { 'recipients.$.openCount': 1 } },
      ).catch(() => {});
    }
  } catch (e) { /* never break the pixel */ }
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.send(PIXEL);
};

// Sent/opened/replied rollup. Replies = a triage reply from a recipient's email
// dated at/after their send (best-effort, decoupled from the send path).
async function computeStats(nl) {
  const recips = nl.recipients || [];
  const sent = recips.filter((r) => r.sentAt);
  const opened = recips.filter((r) => r.openedAt);
  let replied = 0;
  if (sent.length) {
    const emails = [...new Set(sent.map((r) => String(r.email || '').toLowerCase()).filter(Boolean))];
    const earliest = sent.reduce((min, r) => Math.min(min, new Date(r.sentAt).getTime()), Infinity);
    const replies = await TriageReply.find({ fromEmail: { $in: emails }, receivedAt: { $gte: new Date(earliest) } })
      .select('fromEmail').lean().catch(() => []);
    replied = new Set(replies.map((x) => String(x.fromEmail || '').toLowerCase())).size;
  }
  return {
    audience: recips.length, sent: sent.length,
    opened: opened.length, openRate: sent.length ? Math.round(opened.length / sent.length * 100) : 0,
    replied, failed: recips.filter((r) => r.failed).length,
  };
}

module.exports = {
  listNewsletters, createNewsletter, getNewsletter, patchNewsletter,
  uploadFile, previewAudience, sendTest, sendNewsletter, openPixel,
  // exported for reuse/tests
  bodyToHtml, resolveAudience, canSend,
};
