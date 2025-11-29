// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();

const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Ensure the uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});

const upload = multer({ storage });

// Mongo
mongoose.connect(process.env.MONGO_URI);
require('./gridfs'); // Initialize GridFS by importing gridfs.js

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// Routes
const productRoutes = require('./routes/productRoutes');
const emailRoutes = require('./routes/emailRoutes');

app.use('/api/products', productRoutes);

// Accept up to 10 files from the "files" field on any /api/email route
app.use('/api/email', upload.array('files', 10), emailRoutes);

app.listen(PORT, () => {
  console.log(`Server up & running on port ${PORT}`);
});
