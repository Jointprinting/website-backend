// utils/sendEmail.js
//
// Single place every outgoing email goes through. Backed by Resend
// (https://resend.com). Sending domain (jointprinting.com) must be verified
// in the Resend dashboard and the `from` address must live on that domain.
//
// Required env:
//   RESEND_API_KEY  – API key from Resend → API Keys (starts with "re_")
//   EMAIL_FROM      – default sender, e.g. "Joint Printing <noreply@jointprinting.com>"
//
// Callers: controllers/email.js (contact form) and controllers/approval.js
// (admin notifications + client approval links).

const { Resend } = require('resend');

// Instantiate lazily-ish: the client is cheap and stateless, but we still
// guard each send so a missing key produces a clear error instead of a
// cryptic 401 from the API.
const resend = new Resend(process.env.RESEND_API_KEY);

const DEFAULT_FROM =
  process.env.EMAIL_FROM || 'Joint Printing <noreply@jointprinting.com>';

/**
 * Send an email through Resend.
 *
 * @param {Object} options
 * @param {string|string[]} options.to            Recipient(s).
 * @param {string}          options.subject        Subject line.
 * @param {string}          [options.html]         HTML body.
 * @param {string}          [options.text]         Plain-text body.
 * @param {string}          [options.from]         Override sender (defaults to EMAIL_FROM).
 * @param {string|string[]} [options.replyTo]      Reply-To address(es).
 * @param {string|string[]} [options.cc]
 * @param {string|string[]} [options.bcc]
 * @param {Array<{filename:string, content:Buffer|string, contentType?:string}>} [options.attachments]
 * @returns {Promise<{id:string}>}                 Resend's response data (contains the email id).
 */
const sendEmail = async (options = {}) => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      'RESEND_API_KEY is not set — set it in the environment before sending email.'
    );
  }

  const { to, subject, html, text, from, replyTo, cc, bcc, attachments } = options;

  if (!to) throw new Error('sendEmail: "to" is required');
  if (!subject) throw new Error('sendEmail: "subject" is required');
  if (!html && !text) throw new Error('sendEmail: provide "html" or "text"');

  const payload = {
    from: from || DEFAULT_FROM,
    to,
    subject,
  };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (replyTo) payload.replyTo = replyTo;
  if (cc) payload.cc = cc;
  if (bcc) payload.bcc = bcc;
  if (Array.isArray(attachments) && attachments.length) {
    payload.attachments = attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.contentType ? { contentType: a.contentType } : {}),
    }));
  }

  const { data, error } = await resend.emails.send(payload);

  if (error) {
    // Resend returns errors in-band ({ data:null, error:{...} }) rather than
    // throwing. Normalize to a thrown Error so callers' try/catch works.
    const message = error.message || JSON.stringify(error);
    console.error('❌ Resend send failed:', message);
    throw new Error(message);
  }

  console.log('✅ Email sent via Resend:', data && data.id);
  return data;
};

module.exports = sendEmail;
