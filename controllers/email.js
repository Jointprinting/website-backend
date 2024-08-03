//get the sendgrid api key from the .env file outside this folder
require('dotenv').config({ path: '../.env' });
const sendEmail = require("../utils/sendEmail");

exports.sendContactEmail = async (req, res) => {
    const {name, email, phone, message} = req.body;
    // HTML Message
    const messageBody = `<h1>Contact Request</h1>
    <p><b>${name}</b> (email: <b>${email}</b> and phone: <b>${phone}</b>) sent you this message:</p>
    <br/>
    <p>${message}</p>`;
    try {
        await sendEmail({
            to: process.env.EMAIL_FROM,
            subject: "Get In Touch Request",
            text: messageBody,
        });
        res.status(200).json({ message: "Email sent" });
    } catch (err) {
        console.log(err);
        return next(new ErrorResponse("Email could not be sent", 500));
    }
}

exports.sendMockupRequest = async (req, res) => {
    const { name, businessName, email, phone, quantity, title, instructions } = req.body;
    const logo = req.file ? req.file.path : null;

    const htmlContent = `
        <h1>Mockup Request</h1>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Business Name:</strong> ${businessName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Approximate Quantity:</strong> ${quantity}</p>
        <p><strong>Title:</strong> ${title}</p>
        <p><strong>Design Instructions:</strong> ${instructions}</p>
    `;

    const attachments = logo ? [{
        filename: path.basename(logo),
        path: logo
    }] : [];

    await sendEmail({ to: process.env.EMAIL_FROM, 
        subject: "New Mockup Request", 
        text: htmlContent, 
        attachments: attachments });

    // Clean up uploaded file after sending email
    if (logo) {
        fs.unlink(logo, (err) => {
            if (err) console.log(err);
        });
    }

    res.status(200).send('Email sent successfully');
};