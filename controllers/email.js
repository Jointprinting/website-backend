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
    // The raw error is logged above and stored on the submission (emailError);
    // the public response stays friendly and internals-free.
    return res.status(500).json({
      message: "We couldn't send the email, but we saved your request — Nate will reach out shortly.",
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  JP Webworks — website lead intake
//
//  Feeds the SAME ContactSubmission collection (→ Studio Inquiries inbox) as the
//  merch contact form, tagged source:'webworks'. The print-specific fields
//  (quantity / in-hand / ship-to) don't apply, so it has its own lightweight
//  validation: name + business name + email required, phone optional.
// ─────────────────────────────────────────────────────────────────────────────
function validateWebworksPayload(body) {
  const errors = [];
  const name           = (body.name || '').trim();
  const companyName    = (body.companyName || body.businessName || '').trim();
  const email          = (body.email || '').trim();
  const phone          = (body.phone || '').trim();
  const businessType   = (body.businessType || '').trim();
  const currentWebsite = (body.currentWebsite || '').trim();
  const planInterest   = (body.planInterest || '').trim();
  const serviceArea    = (body.serviceArea || '').trim();
  const notes          = (body.notes || body.anythingElse || '').toString();

  if (!name)        errors.push('name is required');
  if (!companyName) errors.push('business name is required');
  if (!email)       errors.push('email is required');
  if (email && !validator.isEmail(email)) errors.push('email is invalid');
  if (!phone) errors.push('phone is required');
  else if (!isPlausiblePhone(phone)) errors.push('phone format is invalid');
  if (notes.length > 5000) errors.push('notes is too long');

  return {
    errors,
    cleaned: { name, companyName, email, phone, businessType, currentWebsite, planInterest, serviceArea, notes },
  };
}

// Flatten the structured web fields + free-text into one readable notes blob, so
// the whole lead is visible in the inbox even where only `notes` is rendered.
function composeWebworksNotes(c) {
  return [
    c.businessType   && `Business: ${c.businessType}`,
    c.serviceArea    && `Service area: ${c.serviceArea}`,
    c.planInterest   && `Plan interest: ${c.planInterest}`,
    c.currentWebsite && `Current site: ${c.currentWebsite}`,
    c.notes          && `\n${c.notes}`,
  ].filter(Boolean).join('\n');
}

exports.sendWebworksLead = async (req, res) => {
  let submission = null;

  try {
    const honeypotTriggered = !!(req.body.website || req.body._hp);

    const { errors, cleaned } = validateWebworksPayload(req.body);
    if (errors.length) {
      cleanupFiles(req);
      return res.status(400).json({ message: 'Validation failed', errors });
    }

    submission = await ContactSubmission.create({
      name: cleaned.name,
      companyName: cleaned.companyName,
      email: cleaned.email,
      phone: cleaned.phone,
      notes: composeWebworksNotes(cleaned),
      source: 'webworks',
      webworks: {
        businessType: cleaned.businessType,
        currentWebsite: cleaned.currentWebsite,
        planInterest: cleaned.planInterest,
        serviceArea: cleaned.serviceArea,
      },
      attachments: describeAttachments(req),
      ipAddress: req.ip,
      userAgent: (req.headers['user-agent'] || '').slice(0, 500),
      honeypot: honeypotTriggered,
    });

    if (honeypotTriggered) {
      cleanupFiles(req);
      return res.status(200).json({ message: 'OK' });
    }

    const toAddress   = process.env.EMAIL_TO;
    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;
    const subject = `New JP Webworks lead – ${cleaned.companyName}`;

    const row = (label, val) => `<p><strong>${label}:</strong> ${escapeHtml(val) || '-'}</p>`;
    const html = `
      <h2>New JP Webworks website lead</h2>
      ${row('Name', cleaned.name)}
      ${row('Business', cleaned.companyName)}
      <p><strong>Email:</strong> <a href="mailto:${escapeHtml(cleaned.email)}">${escapeHtml(cleaned.email)}</a></p>
      ${row('Phone', cleaned.phone)}
      ${row('What they do', cleaned.businessType)}
      ${row('Service area', cleaned.serviceArea)}
      ${row('Plan interest', cleaned.planInterest)}
      ${row('Current site', cleaned.currentWebsite)}
      <p><strong>Notes:</strong><br>${escapeHtml(cleaned.notes).replace(/\n/g, '<br>') || '-'}</p>
      <hr>
      <p style="color:#666;font-size:12px">Submission ID: ${submission._id} · source: JP Webworks</p>
    `;
    const text = [
      'New JP Webworks website lead',
      '',
      `Name: ${cleaned.name}`,
      `Business: ${cleaned.companyName}`,
      `Email: ${cleaned.email}`,
      `Phone: ${cleaned.phone || '-'}`,
      `What they do: ${cleaned.businessType || '-'}`,
      `Service area: ${cleaned.serviceArea || '-'}`,
      `Plan interest: ${cleaned.planInterest || '-'}`,
      `Current site: ${cleaned.currentWebsite || '-'}`,
      `Notes: ${cleaned.notes || '-'}`,
      '',
      `Submission ID: ${submission._id}`,
    ].join('\n');

    await transporter.sendMail({
      from: `"JP Webworks" <${fromAddress}>`,
      to: toAddress,
      replyTo: cleaned.email,
      subject,
      text,
      html,
    });

    try {
      await transporter.sendMail({
        from: `"JP Webworks" <${fromAddress}>`,
        to: cleaned.email,
        subject: `Thanks for reaching out — JP Webworks`,
        text: webworksAutoReplyText(cleaned),
        html: webworksAutoReplyHtml(cleaned),
      });
    } catch (autoErr) {
      console.warn('JPW auto-reply failed (continuing):', autoErr.message);
    }

    submission.emailStatus = 'sent';
    await submission.save();

    cleanupFiles(req);
    return res.status(200).json({ message: 'Lead received', id: submission._id });
  } catch (err) {
    console.error('❌ Error in sendWebworksLead:', err);
    if (submission) {
      submission.emailStatus = 'failed';
      submission.emailError = String(err.message || err).slice(0, 500);
      try { await submission.save(); } catch (_) {}
    }
    cleanupFiles(req);
    return res.status(500).json({
      message: "We couldn't send the email, but we saved your request — Nate will reach out shortly.",
    });
  }
};

exports.validateWebworksPayload = validateWebworksPayload;
exports.composeWebworksNotes = composeWebworksNotes;

// ─────────────────────────────────────────────────────────────────────────────
//  JP ATOM — studio lead intake (/atom/contact)
//
//  Same ContactSubmission pipeline (→ Studio Inquiries inbox), tagged
//  source:'atom'. Questions fit the product: what shop, what they run on
//  today, monthly volume, what they need the studio to do. Phone optional —
//  software buyers balk at required phone fields.
// ─────────────────────────────────────────────────────────────────────────────
function validateAtomPayload(body) {
  const errors = [];
  const name          = (body.name || '').trim();
  const companyName   = (body.companyName || body.shopName || '').trim();
  const email         = (body.email || '').trim();
  const phone         = (body.phone || '').trim();
  const runsOn        = (body.runsOn || '').toString().trim().slice(0, 300);      // what they use today
  const monthlyVolume = (body.monthlyVolume || '').trim().slice(0, 40);
  const interests     = (body.interests || '').toString().trim().slice(0, 300);   // what matters most
  const notes         = (body.notes || '').toString();

  if (!name)        errors.push('name is required');
  if (!companyName) errors.push('shop / company name is required');
  if (!email)       errors.push('email is required');
  if (email && !validator.isEmail(email)) errors.push('email is invalid');
  if (phone && !isPlausiblePhone(phone)) errors.push('phone format is invalid');
  if (notes.length > 5000) errors.push('notes is too long');

  return { errors, cleaned: { name, companyName, email, phone, runsOn, monthlyVolume, interests, notes } };
}

function composeAtomNotes(c) {
  return [
    c.runsOn        && `Runs on today: ${c.runsOn}`,
    c.monthlyVolume && `Monthly orders: ${c.monthlyVolume}`,
    c.interests     && `Wants: ${c.interests}`,
    c.notes         && `\n${c.notes}`,
  ].filter(Boolean).join('\n');
}

exports.sendAtomLead = async (req, res) => {
  let submission = null;
  try {
    const honeypotTriggered = !!(req.body.website || req.body._hp);
    const { errors, cleaned } = validateAtomPayload(req.body);
    if (errors.length) {
      cleanupFiles(req);
      return res.status(400).json({ message: 'Validation failed', errors });
    }

    submission = await ContactSubmission.create({
      name: cleaned.name,
      companyName: cleaned.companyName,
      email: cleaned.email,
      // Model requires phone; software leads often skip it — store a dash.
      phone: cleaned.phone || '-',
      notes: composeAtomNotes(cleaned),
      source: 'atom',
      ipAddress: req.ip,
      userAgent: (req.headers['user-agent'] || '').slice(0, 500),
      honeypot: honeypotTriggered,
    });

    if (honeypotTriggered) {
      cleanupFiles(req);
      return res.status(200).json({ message: 'OK' });
    }

    const toAddress   = process.env.EMAIL_TO;
    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;
    const row = (label, val) => `<p><strong>${label}:</strong> ${escapeHtml(val) || '-'}</p>`;
    await transporter.sendMail({
      from: `"JP Atom" <${fromAddress}>`,
      to: toAddress,
      replyTo: cleaned.email,
      subject: `New JP Atom lead – ${cleaned.companyName}`,
      text: [
        'New JP Atom studio lead', '',
        `Name: ${cleaned.name}`, `Shop: ${cleaned.companyName}`,
        `Email: ${cleaned.email}`, `Phone: ${cleaned.phone || '-'}`,
        `Runs on today: ${cleaned.runsOn || '-'}`,
        `Monthly orders: ${cleaned.monthlyVolume || '-'}`,
        `Wants: ${cleaned.interests || '-'}`,
        `Notes: ${cleaned.notes || '-'}`, '',
        `Submission ID: ${submission._id}`,
      ].join('\n'),
      html: `
        <h2>New JP Atom studio lead</h2>
        ${row('Name', cleaned.name)}
        ${row('Shop', cleaned.companyName)}
        <p><strong>Email:</strong> <a href="mailto:${escapeHtml(cleaned.email)}">${escapeHtml(cleaned.email)}</a></p>
        ${row('Phone', cleaned.phone)}
        ${row('Runs on today', cleaned.runsOn)}
        ${row('Monthly orders', cleaned.monthlyVolume)}
        ${row('Wants', cleaned.interests)}
        <p><strong>Notes:</strong><br>${escapeHtml(cleaned.notes).replace(/\n/g, '<br>') || '-'}</p>
        <hr>
        <p style="color:#666;font-size:12px">Submission ID: ${submission._id} · source: JP Atom</p>
      `,
    });

    try {
      await transporter.sendMail({
        from: `"JP Atom" <${fromAddress}>`,
        to: cleaned.email,
        subject: 'Got it — JP Atom',
        text: `Hey ${cleaned.name.split(' ')[0]},\n\nThanks for raising your hand for JP Atom. I'll reach out within one business day to set up a quick walkthrough with your shop's numbers in it.\n\nMeanwhile the live demo is always open: jointprinting.com/atom/demo\n\n— Nate\nJP Atom · built inside a working merch shop`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.6">
            <h2 style="color:#7c3aed;margin-bottom:6px">Got it, ${escapeHtml(cleaned.name.split(' ')[0])} ⚛</h2>
            <p>Thanks for raising your hand for <strong>JP Atom</strong> for ${escapeHtml(cleaned.companyName)}.</p>
            <p>I'll reach out within one business day to set up a quick walkthrough — with your shop's numbers in it, not demo data.</p>
            <p>Meanwhile the live demo is always open:
              <br><a href="https://jointprinting.com/atom/demo" style="color:#7c3aed;font-weight:700">jointprinting.com/atom/demo</a></p>
            <p style="margin-top:24px">— Nate<br><span style="color:#666">JP Atom · built inside a working merch shop</span></p>
          </div>
        `,
      });
    } catch (autoErr) {
      console.warn('JP Atom auto-reply failed (continuing):', autoErr.message);
    }

    submission.emailStatus = 'sent';
    await submission.save();
    cleanupFiles(req);
    return res.status(200).json({ message: 'Lead received', id: submission._id });
  } catch (err) {
    console.error('❌ Error in sendAtomLead:', err);
    if (submission) {
      submission.emailStatus = 'failed';
      submission.emailError = String(err.message || err).slice(0, 500);
      try { await submission.save(); } catch (_) {}
    }
    cleanupFiles(req);
    return res.status(500).json({
      message: "We couldn't send the email, but we saved your request — Nate will reach out shortly.",
    });
  }
};
exports.validateAtomPayload = validateAtomPayload;

function webworksAutoReplyHtml(c) {
  const plan = c.planInterest && c.planInterest.toLowerCase() !== 'not sure yet'
    ? `<p>You mentioned you're leaning toward the <strong>${escapeHtml(c.planInterest)}</strong> plan — we'll build the recommendation around that (and it's easy to change).</p>`
    : '';
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.6">
      <h2 style="color:#0f8f5c;margin-bottom:6px">Got it, ${escapeHtml(c.name.split(' ')[0])} 👋</h2>
      <p>Thanks for reaching out about a website for <strong>${escapeHtml(c.companyName)}</strong>.</p>
      <p>I'll take a look and get back to you — usually within one business day — with a quick plan and a price. No pressure and nothing owed.</p>
      ${plan}
      <p style="margin-top:24px">Want to talk it through sooner? Grab a free 15-minute call:
        <br><a href="https://calendly.com/nate-jointprinting/30min" style="color:#0f8f5c;font-weight:700">calendly.com/nate-jointprinting/30min</a>
      </p>
      <p style="margin-top:24px">— Nate<br><span style="color:#888;font-size:13px">JP Webworks</span></p>
    </div>
  `;
}

function webworksAutoReplyText(c) {
  const plan = c.planInterest && c.planInterest.toLowerCase() !== 'not sure yet'
    ? `\nYou mentioned the ${c.planInterest} plan — we'll build the recommendation around that (easy to change).\n`
    : '';
  return [
    `Got it, ${c.name.split(' ')[0]} —`,
    '',
    `Thanks for reaching out about a website for ${c.companyName}. I'll take a look and get back to you, usually within one business day, with a quick plan and a price. No pressure and nothing owed.`,
    plan,
    'Want to talk sooner? Grab a free 15-minute call: https://calendly.com/nate-jointprinting/30min',
    '',
    '— Nate',
    'JP Webworks',
  ].join('\n');
}

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
