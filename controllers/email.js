// controllers/email.js
require('dotenv').config();
const nodemailer = require('nodemailer');

/**
 * Create a reusable transporter using SMTP settings from .env
 * Required env vars:
 *   SMTP_HOST
 *   SMTP_PORT
 *   SMTP_USER
 *   SMTP_PASS
 *   CONTACT_TO        -> where contact form emails should go
 *   CONTACT_FROM      -> optional, defaults to SMTP_USER
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465, // true for 465, false otherwise
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Helper to normalize attachments from multer
 * Works with upload.single(...) and upload.array(...)
 */
function getAttachments(req) {
  const files = [];

  if (Array.isArray(req.files) && req.files.length > 0) {
    req.files.forEach((file) => {
      files.push({
        filename: file.originalname,
        path: file.path,
      });
    });
  } else if (req.file) {
    files.push({
      filename: req.file.originalname,
      path: req.file.path,
    });
  }

  return files;
}

/**
 * Contact form handler
 * Expects (from your React form / Contact.js):
 *   name
 *   companyName
 *   email
 *   phone
 *   quantity
 *   inHandDate
 *   anythingElse
 *   selectedProducts (JSON string or array)
 *   + optional uploaded design files via multer
 */
exports.sendContactEmail = async (req, res) => {
  try {
    const {
      name,
      companyName,
      email,
      phone,
      quantity,
      inHandDate,
      anythingElse,
      selectedProducts,
    } = req.body;

    // Parse selectedProducts whether it comes as JSON string or already as array
    let products = [];
    if (selectedProducts) {
      try {
        products =
          typeof selectedProducts === 'string'
            ? JSON.parse(selectedProducts)
            : selectedProducts;
      } catch (e) {
        console.warn('Could not parse selectedProducts, raw value:', selectedProducts);
      }
    }

    const attachments = getAttachments(req);

    const toAddress = process.env.CONTACT_TO;
    const fromAddress = process.env.CONTACT_FROM || process.env.SMTP_USER;

    if (!toAddress) {
      console.error('CONTACT_TO is not set in environment variables');
      return res
        .status(500)
        .json({ message: 'Email configuration error (CONTACT_TO not set).' });
    }

    const productLines =
      Array.isArray(products) && products.length > 0
        ? products
            .map(
              (p, idx) =>
                `${idx + 1}. ${p.name || 'Product'} (Style ${
                  p.style || 'N/A'
                })${p.vendor ? ` — ${p.vendor}` : ''}`
            )
            .join('\n')
        : 'No specific products selected.';

    const textBody = `
New contact form submission from Joint Printing

Name: ${name || '-'}
Company: ${companyName || '-'}
Email: ${email || '-'}
Phone: ${phone || '-'}

Quantity (for each item): ${quantity || '-'}
In-hand date: ${inHandDate || '-'}

Selected products:
${productLines}

Anything else:
${anythingElse || '-'}
`;

    const htmlBody = `
  <h2>New contact form submission from Joint Printing</h2>
  <p><strong>Name:</strong> ${name || '-'}</p>
  <p><strong>Company:</strong> ${companyName || '-'}</p>
  <p><strong>Email:</strong> ${email || '-'}</p>
  <p><strong>Phone:</strong> ${phone || '-'}</p>
  <p><strong>Quantity (for each item):</strong> ${quantity || '-'}</p>
  <p><strong>In-hand date:</strong> ${inHandDate || '-'}</p>
  <h3>Selected products</h3>
  <pre style="font-family: monospace; white-space: pre-wrap;">${productLines}</pre>
  <h3>Anything else</h3>
  <p>${(anythingElse || '-').replace(/\n/g, '<br/>')}</p>
  <p><em>Attached design files are included if the customer uploaded any.</em></p>
`;

    const mailOptions = {
      from: fromAddress,
      to: toAddress,
      subject: `New mockup & quote request from ${name || 'Joint Printing site'}`,
      text: textBody,
      html: htmlBody,
      attachments,
    };

    await transporter.sendMail(mailOptions);

    return res.status(200).json({ message: 'Email sent successfully' });
  } catch (err) {
    console.error('Error in sendContactEmail:', err);
    return res
      .status(500)
      .json({ message: 'Failed to send contact email', error: err.message });
  }
};

/**
 * Mockup request handler (if you use it separately from the main contact form)
 * For now this just forwards the payload similarly.
 */
exports.sendMockupRequest = async (req, res) => {
  try {
    const { name, email, details } = req.body || {};
    const attachments = getAttachments(req);

    const toAddress = process.env.CONTACT_TO;
    const fromAddress = process.env.CONTACT_FROM || process.env.SMTP_USER;

    const textBody = `
New mockup request

Name: ${name || '-'}
Email: ${email || '-'}

Details:
${details || '-'}
`;

    await transporter.sendMail({
      from: fromAddress,
      to: toAddress,
      subject: `New mockup request from ${name || 'Joint Printing site'}`,
      text: textBody,
      attachments,
    });

    return res.status(200).json({ message: 'Mockup request sent successfully' });
  } catch (err) {
    console.error('Error in sendMockupRequest:', err);
    return res
      .status(500)
      .json({ message: 'Failed to send mockup request', error: err.message });
  }
};
