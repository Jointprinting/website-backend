const nodemailer = require('nodemailer');

// The core function called by your controllers (email.js)
const sendEmail = async (options) => {
    // Per-identity SMTP (options.smtp) lets the outreach engine round-robin across
    // several free-tier ESP inboxes for more free daily volume; falls back to the
    // global SMTP_* env when none is passed (all other callers, and legacy senders).
    const smtp = options.smtp || {};
    const host = smtp.host || process.env.SMTP_HOST;
    const port = String(smtp.port || process.env.SMTP_PORT || '587');
    const user = smtp.user || process.env.SMTP_USER;
    const pass = smtp.pass || process.env.SMTP_PASS;
    const transporter = nodemailer.createTransport({
        host,
        port,
        // 'secure: true' for port 465 (SMTPS); false for 587/2525 (STARTTLS).
        secure: port === '465',
        auth: { user, pass },
    });

    const mailOptions = {
        // Sender defaults to EMAIL_FROM; callers may override (the outreach
        // engine sends from a dedicated OUTREACH_EMAIL_FROM identity so cold
        // volume never rides the main transactional address).
        from: options.from || process.env.EMAIL_FROM,
        to: options.to,
        subject: options.subject,
        html: options.text || options.html, // Support both text and html options
        attachments: options.attachments || []
    };
    if (options.replyTo) mailOptions.replyTo = options.replyTo;
    if (options.headers) mailOptions.headers = options.headers;   // e.g. List-Unsubscribe
    if (options.textAlt) mailOptions.text = options.textAlt;      // plain-text alternative part
    // A caller-supplied stable Message-ID (the outreach engine keys one per
    // enrollment+step) lets the provider dedupe if a crash-retry re-sends the
    // same step, and lets follow-ups thread via In-Reply-To/References.
    if (options.messageId) mailOptions.messageId = options.messageId;
    if (options.inReplyTo) mailOptions.inReplyTo = options.inReplyTo;
    if (options.references) mailOptions.references = options.references;

    // FIX 2: Replace the Promise wrapper with direct async/await call (cleaner)
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log("Message sent: %s", info.messageId);
        return info; // Resolve successful send
    } catch (error) {
        // IMPORTANT: The promise wrapper in your original code handles the error, 
        // but by using async/await and returning the error, your email.js catch block 
        // is triggered. Since you already implemented a non-crashing catch in email.js,
        // this is now safe!
        console.error("Email failed via SendPulse (or other SMTP):", error.message);
        throw error; // Propagate the error back to the caller (email.js)
    }
};

module.exports = sendEmail;
