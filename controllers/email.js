// controllers/email.js
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ---- Transporter setup ----
// Make sure these are set in Render:
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465, // true for 465, false otherwise
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Optional: log if SMTP is misconfigured
transporter.verify((err, success) => {
  if (err) {
    console.error('❌ SMTP configuration error:', err.message);
  } else {
    console.log('✅ SMTP server is ready to take messages');
  }
});

// Helper: turn uploaded files into Nodemailer attachments
function getAttachments(req) {
  if (!req.files || !Array.isArray(req.files)) return [];

  return req.files.map((file) => ({
    filename: file.originalname,
    path: file.path, // Nodemailer will read the file from disk
    contentType: file.mimetype,
  }));
}

// Helper: parse selectedProducts if it is JSON
function parseSelectedProducts(raw) {
  if (!raw) return [];
  try {
    if (Array.isArray(raw)) return raw;
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

// Optional: delete temp upload files after sending
function cleanupFiles(req) {
  if (!req.files || !Array.isArray(req.files)) return;
  req.files.forEach((file) => {
    fs.unlink(file.path, (err) => {
      if (err) {
        console.error('Error deleting temp file:', file.path, err.message);
      }
    });
  });
}

// ------------------- CONTACT FORM -------------------
exports.sendContactEmail = async (req, res) => {
  try {
    const {
      name,
      companyName,
      email,
      phone,
      quantity,
      inHandDate,
      notes,
      anythingElse,
      selectedProducts,
    } = req.body;

    const products = parseSelectedProducts(selectedProducts);

    const toAddress = process.env.EMAIL_TO;
    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;

    const subject = `New contact form – ${companyName || 'Unknown company'}`;

    const productsHtml =
      products && products.length
        ? `<h3>Selected Products</h3>
           <ul>
             ${products
               .map(
                 (p) =>
                   `<li><strong>${p.vendor || ''} ${p.name || ''}</strong> (style: ${
                     p.style || 'n/a'
                   })</li>`
               )
               .join('')}
           </ul>`
        : '<p><em>No products were selected.</em></p>';

    const html = `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${name || '-'}</p>
      <p><strong>Company:</strong> ${companyName || '-'}</p>
      <p><strong>Email:</strong> ${email || '-'}</p>
      <p><strong>Phone:</strong> ${phone || '-'}</p>
      <p><strong>Quantity (for each item):</strong> ${quantity || '-'}</p>
      <p><strong>In-hand date:</strong> ${inHandDate || '-'}</p>
      <p><strong>Anything else:</strong> ${anythingElse || notes || '-'}</p>
      ${productsHtml}
    `;

    const text = `
New contact form submission

Name: ${name || '-'}
Company: ${companyName || '-'}
Email: ${email || '-'}
Phone: ${phone || '-'}
Quantity (for each item): ${quantity || '-'}
In-hand date: ${inHandDate || '-'}
Anything else: ${anythingElse || notes || '-'}

Selected products:
${(products || [])
  .map((p) => `- ${p.vendor || ''} ${p.name || ''} (style: ${p.style || 'n/a'})`)
  .join('\n')}
    `.trim();

    const attachments = getAttachments(req);

    const mailOptions = {
      from: fromAddress,
      to: toAddress,
      replyTo: email || fromAddress,
      subject,
      text,
      html,
      attachments,
    };

    await transporter.sendMail(mailOptions);

    // clean up uploaded files
    cleanupFiles(req);

    return res.status(200).json({ message: 'Contact email sent successfully' });
  } catch (err) {
    console.error('❌ Error in sendContactEmail:', err);
    return res.status(500).json({
      message: 'Failed to send contact email',
      error: err.message,
    });
  }
};

// ------------------- PRODUCT MOCKUP REQUEST -------------------
exports.sendMockupRequest = async (req, res) => {
  try {
    const {
      name,
      companyName,
      email,
      phone,
      quantity,
      inHandDate,
      notes,
      anythingElse,
      selectedProducts,
    } = req.body;

    const products = parseSelectedProducts(selectedProducts);

    const toAddress = process.env.EMAIL_TO;
    const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_USER;

    const subject = `New mockup/quote request – ${companyName || 'Unknown company'}`;

    const productsHtml =
      products && products.length
        ? `<h3>Requested Products</h3>
           <ul>
             ${products
               .map(
                 (p) =>
                   `<li><strong>${p.vendor || ''} ${p.name || ''}</strong> (style: ${
                     p.style || 'n/a'
                   })</li>`
               )
               .join('')}
           </ul>`
        : '<p><em>No specific products were sent in the payload.</em></p>';

    const html = `
      <h2>New Mockup / Quote Request</h2>
      <p><strong>Name:</strong> ${name || '-'}</p>
      <p><strong>Company:</strong> ${companyName || '-'}</p>
      <p><strong>Email:</strong> ${email || '-'}</p>
      <p><strong>Phone:</strong> ${phone || '-'}</p>
      <p><strong>Quantity (for each item):</strong> ${quantity || '-'}</p>
      <p><strong>In-hand date:</strong> ${inHandDate || '-'}</p>
      <p><strong>Anything else:</strong> ${anythingElse || notes || '-'}</p>
      ${productsHtml}
    `;

    const text = `
New mockup / quote request

Name: ${name || '-'}
Company: ${companyName || '-'}
Email: ${email || '-'}
Phone: ${phone || '-'}
Quantity (for each item): ${quantity || '-'}
In-hand date: ${inHandDate || '-'}
Anything else: ${anythingElse || notes || '-'}

Requested products:
${(products || [])
  .map((p) => `- ${p.vendor || ''} ${p.name || ''} (style: ${p.style || 'n/a'})`)
  .join('\n')}
    `.trim();

    const attachments = getAttachments(req);

    const mailOptions = {
      from: fromAddress,
      to: toAddress,
      replyTo: email || fromAddress,
      subject,
      text,
      html,
      attachments,
    };

    await transporter.sendMail(mailOptions);
    cleanupFiles(req);

    return res
      .status(200)
      .json({ message: 'Mockup / quote email sent successfully' });
  } catch (err) {
    console.error('❌ Error in sendMockupRequest:', err);
    return res.status(500).json({
      message: 'Failed to send mockup request email',
      error: err.message,
    });
  }
};
