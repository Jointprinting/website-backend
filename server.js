require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');

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

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
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
  console.log(`Mongoose server is running on port ${PORT}`);
});


