// controllers/email.js
const nodemailer = require('nodemailer');
const fs = require('fs');
const validator = require('validator');
const ContactSubmission = require('../models/ContactSubmission');

// SMTP transport. Auto-picks `secure` based on port:
//   - Gmail (port 465) → secure: true
//   - SendPulse / others (port 587 or 2525) → secure: false (uses STARTTLS)
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((err) => {
  if (err) console.error('❌ SMTP configuration error:', err.message);
  else      console.log('✅ SMTP server is ready to take messages');
});

function getAttachments(req) {
  if (!req.files || !Array.isArray(req.files)) return [];
  return req.files.map((file) => ({
    filename: file.originalname,
    path: file.path,
    contentType: file.mimetype,
  }));
}

function describeAttachments(req) {
  if (!req.files || !Array.isArray(req.files)) return [];
  return req.files.map((f) => ({
    filename: f.originalname,
    contentType: f.mimetype,
    sizeBytes: f.size,
  }));
}

function parseSelectedProducts(raw) {
  if (!raw) return [];
  try {
    if (Array.isArray(raw)) return raw;
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

function cleanupFiles(req) {
  if (!req.files || !Array.isArray(req.files)) return;
  req.files.forEach((file) => {
    fs.unlink(file.path, (err) => {
      if (err) console.error('Error deleting temp file:', file.path, err.message);
    });
  });
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Permissive phone check: 7-15 digits in any format
function isPlausiblePhone(s) {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function validatePayload(body) {
  const errors = [];
  const name        = (body.name || '').trim();
  const companyName = (body.companyName || '').trim();
  const email       = (body.email || '').trim();
  const phone       = (body.phone || '').trim();
  const quantity    = (body.quantity || '').trim();
  const inHandDate  = (body.inHandDate || '').trim();
  const notes       = (body.notes || body.anythingElse || '').toString();
  const shipToState = (body.shipToState || '').trim();

  if (!name)        errors.push('name is required');
  if (!companyName) errors.push('companyName is required');
  if (!email)       errors.push('email is required');
  if (email && !validator.isEmail(email)) errors.push('email is invalid');
  if (!phone) errors.push('phone is required');
  if (phone && !isPlausiblePhone(phone)) errors.push('phone format is invalid');
  if (!quantity)   errors.push('quantity is required');
  if (!inHandDate) errors.push('inHandDate is required');
  if (!shipToState) errors.push('shipToState is required');
  if (notes.length > 5000) errors.push('notes is too long');

  return {
    errors,
    cleaned: { name, companyName, email, phone, quantity, inHandDate, notes, shipToState },
  };
}

exports.sendContactEmail = async (req, res) => {
  let submission = null;

  try {
    const honeypotTriggered = !!(req.body.website || req.body._hp);

    const { errors, cleaned } = validatePayload(req.body);
    if (errors.length) {
      cleanupFiles(req);
      return res.status(400).json({ message: 'Validation failed', errors });
    }

    const products = parseSelectedProducts(req.body.selectedProducts);

    submission = await ContactSubmission.create({
      ...cleaned,
      selectedProducts: products,
      attachments: describeAttachments(req),
      ipAddress: req.ip,
      userAgent: (req.headers['user-agent'] || '').slice(0, 500),
      honeypot: honeypotTriggered,
    });

    if (honeypotTriggered) {
      cleanupFiles(req);
      return res.status(200).json({ message: 'OK' });
    }

    const toAddress  = process.env.EMAIL_TO;
    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;
    const subject = `New contact form – ${cleaned.companyName}`;

    const productsHtml = products.length
      ? `<h3>Selected Products</h3><ul>${products
          .map(p => `<li><strong>${escapeHtml(p.vendor || '')} ${escapeHtml(p.name || '')}</strong> (style: ${escapeHtml(p.style || 'n/a')})</li>`)
          .join('')}</ul>`
      : '<p><em>No products were selected.</em></p>';

    const html = `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${escapeHtml(cleaned.name)}</p>
      <p><strong>Company:</strong> ${escapeHtml(cleaned.companyName)}</p>
      <p><strong>Email:</strong> <a href="mailto:${escapeHtml(cleaned.email)}">${escapeHtml(cleaned.email)}</a></p>
      <p><strong>Phone:</strong> ${escapeHtml(cleaned.phone)}</p>
      <p><strong>Quantity:</strong> ${escapeHtml(cleaned.quantity)}</p>
      <p><strong>In-hand date:</strong> ${escapeHtml(cleaned.inHandDate)}</p>
      <p><strong>Notes:</strong><br>${escapeHtml(cleaned.notes).replace(/\n/g, '<br>') || '-'}</p>
      <p><strong>Ship-to state / province:</strong> ${escapeHtml(cleaned.shipToState) || '-'}</p>
      ${productsHtml}
      <hr>
      <p style="color:#666;font-size:12px">Submission ID: ${submission._id}</p>
    `;

    const text = [
      'New contact form submission',
      '',
      `Name: ${cleaned.name}`,
      `Company: ${cleaned.companyName}`,
      `Email: ${cleaned.email}`,
      `Phone: ${cleaned.phone}`,
      `Quantity: ${cleaned.quantity}`,
      `In-hand: ${cleaned.inHandDate}`,
      `Notes: ${cleaned.notes || '-'}`,
      `Ship-to state: ${cleaned.shipToState || '-'}`,
      '',
      'Products:',
      ...products.map(p => `- ${p.vendor || ''} ${p.name || ''} (style: ${p.style || 'n/a'})`),
      '',
      `Submission ID: ${submission._id}`,
    ].join('\n');

    await transporter.sendMail({
      from: `"Joint Printing" <${fromAddress}>`,
      to: toAddress,
      replyTo: cleaned.email,
      subject,
      text,
      html,
      attachments: getAttachments(req),
    });

    try {
      await transporter.sendMail({
        from: `"Joint Printing" <${fromAddress}>`,
        to: cleaned.email,
        subject: `We got your request — Joint Printing`,
        text: customerAutoReplyText(cleaned, products),
        html: customerAutoReplyHtml(cleaned, products),
      });
    } catch (autoErr) {
      console.warn('Auto-reply failed (continuing):', autoErr.message);
    }

    submission.emailStatus = 'sent';
    await submission.save();

    cleanupFiles(req);
    return res.status(200).json({ message: 'Contact email sent successfully', id: submission._id });
  } catch (err) {
    console.error('❌ Error in sendContactEmail:', err);
    if (submission) {
      submission.emailStatus = 'failed';
      submission.emailError = String(err.message || err).slice(0, 500);
      try { await submission.save(); } catch (_) {}
    }
    cleanupFiles(req);
    return res.status(500).json({
      message: "We couldn't send the email, but we saved your request — Nate will reach out shortly.",
      error: err.message,
    });
  }
};

function customerAutoReplyHtml(c, products) {
  const list = products.length
    ? `<p><strong>What you're asking about:</strong></p>
       <ul>${products.map(p => `<li>${escapeHtml(p.vendor || '')} ${escapeHtml(p.name || '')} (style ${escapeHtml(p.style || 'n/a')})</li>`).join('')}</ul>`
    : '';
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.6">
      <h2 style="color:#1a3d2b;margin-bottom:6px">Got it, ${escapeHtml(c.name.split(' ')[0])} 👋</h2>
      <p>Thanks for reaching out about merch for <strong>${escapeHtml(c.companyName)}</strong>.</p>
      <p>We just got your request and will get back to you with a mockup and quote — usually within 24 hours.</p>
      ${list}
      <p style="margin-top:24px">In the meantime, you can also book a free 30-minute call:
        <br><a href="https://calendly.com/nate-jointprinting/30min" style="color:#1a3d2b;font-weight:700">calendly.com/nate-jointprinting/30min</a>
      </p>
      <p style="margin-top:24px">— Nate<br><span style="color:#888;font-size:13px">Joint Printing</span></p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#888;font-size:12px">P.S. New customer? Use code <strong>WELCOME10</strong> for 10% off your first order (up to $100).</p>
    </div>
  `;
}

function customerAutoReplyText(c, products) {
  const list = products.length
    ? '\nYou asked about:\n' + products.map(p => `- ${p.vendor || ''} ${p.name || ''} (style ${p.style || 'n/a'})`).join('\n') + '\n'
    : '';
  return [
    `Got it, ${c.name.split(' ')[0]} —`,
    '',
    `Thanks for reaching out about merch for ${c.companyName}. We just got your request and will get back to you with a mockup and quote, usually within 24 hours.`,
    list,
    'You can also book a free 30-minute call: https://calendly.com/nate-jointprinting/30min',
    '',
    '— Nate',
    'Joint Printing',
    '',
    'P.S. New customer? Use code WELCOME10 for 10% off your first order (up to $100).',
  ].join('\n');
}

// sendMockupRequest (a thin alias of sendContactEmail) was retired along with the
// public /customize page — /api/email/send-contact is the one submission path.
