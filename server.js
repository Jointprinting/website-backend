require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 8080; //changed port bc 5000 was already in use

app.use(cors());
app.use(express.json());

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
app.use('/api/email', emailRoutes);

app.listen(PORT, () => {
  console.log(`Mongoose server is running on port ${PORT}`);
});


