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
            to: 'adr7310@gmail.com',//process.env.EMAIL_FROM,
            subject: "Get In Touch Request",
            text: messageBody,
        });
        res.status(200).json({ message: "Email sent" });
    } catch (err) {
        console.log(err);
        return next(new ErrorResponse("Email could not be sent", 500));
    }
}