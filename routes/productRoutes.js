// routes/productRoutes.js
const express = require('express');
const router = express.Router();

const {
  getProducts,
  getProductById,
  getProductByStyleCode,
  createProduct,
  syncFromSS,
  getCategories,
  getTypes,
} = require('../controllers/product');

const { requireAdmin } = require('../middleware/auth');

// Public reads
router.get('/', getProducts);
router.get('/categories', getCategories);
router.get('/types', getTypes);
router.get('/style/:style', getProductByStyleCode);
router.get('/:id', getProductById);

// Admin writes — require studio token
router.post('/add', requireAdmin, createProduct);          // Alpha Broder fallback
router.post('/ss/sync', requireAdmin, syncFromSS);         // S&S Activewear smart sync

module.exports = router;
