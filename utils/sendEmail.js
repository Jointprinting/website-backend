const nodemailer = require('nodemailer');

// The core function called by your controllers (email.js)
const sendEmail = async (options) => {
    // FIX 1: Configure transporter to use the new SMTP variables (SendPulse)
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST, 
        port: process.env.SMTP_PORT, 
        // Use 'secure: true' for port 465 (SMTPS), or 'secure: false' for port 2525 (TLS)
        secure: process.env.SMTP_PORT === '465', 
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
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
