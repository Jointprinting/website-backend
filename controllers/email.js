//get the sendgrid api key from the .env file outside this folder
require('dotenv').config({ path: '../.env' });
const sendEmail = require("../utils/sendEmail");
const fs = require('fs').promises;
const path = require('path');

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
    console.log('running')
    const { name, businessName, email, phone, quantity, title, instructions, styleCode } = req.body;
    const logo = req.file ? req.file.path : null;
    console.log('logo', logo)
    console.log('req.file', req.file)

    const htmlContent = `
        <h1>Mockup Request</h1>
        <p><strong>Product Style Code:</strong> ${styleCode}</p>
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

    try {
        // Ensure file exists before sending email
        if (logo) {
            await fs.access(logo);
            console.log('File exists:', logo);
        }

        await sendEmail({ 
            to: process.env.EMAIL_FROM,
            subject: "New Mockup Request", 
            text: htmlContent, 
            attachments: attachments
        });

        // Clean up uploaded file after sending email
        if (logo) {
            await fs.unlink(logo);
            console.log('File deleted:', logo);
        }

        res.status(200).send('Email sent successfully');
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Error sending email');
    }
};