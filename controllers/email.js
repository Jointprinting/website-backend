// controllers/email.js
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// Configure transporter from env
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true', // usually false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Optional: log whether SMTP is ready
transporter.verify((err, success) => {
  if (err) {
    console.error('SMTP connection error:', err.message);
  } else {
    console.log('SMTP server is ready to send emails.');
  }
});

function parseSelectedProducts(raw) {
  if (!raw) return [];
  try {
    // if it was JSON.stringified on the frontend
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function buildBodyText(body, selectedProducts) {
  const {
    name,
    companyName,
    email,
    phone,
    quantity,
    inHandDate,
    notes,
  } = body;

  const productsLines =
    selectedProducts.length > 0
      ? selectedProducts
          .map(
            (p, idx) =>
              `${idx + 1}. ${p.name || 'Product'} (Style ${
                p.style || 'N/A'
              })${p.vendor ? ` — ${p.vendor}` : ''}`
          )
          .join('\n')
      : 'No specific products selected.';

  return `
New quote / mockup request from the Joint Printing website

Name: ${name || ''}
Company: ${companyName || ''}
Email: ${email || ''}
Phone: ${phone || ''}
Quantity (for each item): ${quantity || ''}
In-hand date: ${inHandDate || ''}

Anything else we should know:
${notes || ''}

Selected products:
${productsLines}
`;
}

function collectAttachments(req) {
  const attachments = [];

  if (req.files && Array.isArray(req.files) && req.files.length > 0) {
    req.files.forEach((file) => {
      attachments.push({
        filename: file.originalname,
        path: file.path,
      });
    });
  } else if (req.file) {
    attachments.push({
      filename: req.file.originalname,
      path: req.file.path,
    });
  }

  return attachments;
}

async function sendEmailWithCleanup(mailOptions, attachments) {
  try {
    await transporter.sendMail(mailOptions);
  } finally {
    // Clean up uploaded files so they don't pile up on disk
    if (attachments && attachments.length) {
      attachments.forEach((att) => {
        if (att.path) {
          fs.unlink(att.path, (err) => {
            if (err) {
              console.error('Error deleting temp file:', att.path, err.message);
            }
          });
        }
      });
    }
  }
}

exports.sendContactEmail = async (req, res) => {
  try {
    const selectedProducts = parseSelectedProducts(req.body.selectedProducts);
    const attachments = collectAttachments(req);
    const text = buildBodyText(req.body, selectedProducts);

    const mailOptions = {
      from:
        process.env.SMTP_FROM ||
        '"Joint Printing Website" <no-reply@jointprinting.com>',
      to: process.env.SMTP_TO || process.env.SMTP_FROM || 'nate@jointprinting.com',
      subject: 'New quote / mockup request from jointprinting.com',
      text,
      attachments,
    };

    await sendEmailWithCleanup(mailOptions, attachments);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error in sendContactEmail:', err);
    return res
      .status(500)
      .json({ success: false, message: 'Failed to send email.' });
  }
};

// If you ever call /send-mockup-request, just reuse the same handler
exports.sendMockupRequest = exports.sendContactEmail;
