require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { GridFSBucket } = require('mongodb');

const app = express();

const PORT = process.env.PORT || 8080; //changed port bc 5000 was already in use

app.use(cors());
app.use(express.json());


// Set up storage engine
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
      cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });

const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI);
require('./gridfs'); // Initialize GridFS by importing gridfs.js

let gfs;
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
  //gfs = new GridFSBucket(db, { bucketName: 'images' }); // Initialize GridFS bucket
  /*gfs = new mongoose.mongo.GridFSBucket(db, {
    bucketName: "images",
  });
  module.exports.gfs = gfs; // Export gfs once it is initialized*/
});

const productRoutes = require('./routes/productRoutes');
const emailRoutes = require('./routes/emailRoutes');
app.use('/api/products', productRoutes);
app.use('/api/email', upload.single('logo'), emailRoutes);

// Ensure the uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

app.listen(PORT, () => {
  console.log(`Server up & running on port ${PORT}`);
});


