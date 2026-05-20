// routes/productRoutes.js
const express = require('express');
const router = express.Router();

const {
  getProducts,
  getProductById,
  getProductByStyleCode,
  createProduct,
  syncFromSS,
  refreshAllSSProductsHandler,
  importFromJson,
  getCategories,
  getTypes,
  browseSS,
  getSSBrands,
  getSSStyleDetail,
  testSSConnection,
} = require('../controllers/product');

const { requireAdmin } = require('../middleware/auth');

// Public reads
router.get('/', getProducts);
router.get('/categories', getCategories);
router.get('/types', getTypes);
router.get('/ss/brands', getSSBrands);
router.get('/ss/browse', browseSS);
router.get('/ss/test', testSSConnection);              // connectivity / credential check
router.get('/ss/style/:style', getSSStyleDetail);      // live S&S detail for Product page
router.get('/style/:style', getProductByStyleCode);
router.get('/:id', getProductById);

// Admin writes — require studio token
router.post('/add', requireAdmin, createProduct);                          // Alpha Broder fallback
router.post('/ss/sync', requireAdmin, syncFromSS);                         // S&S Activewear smart sync
router.post('/ss/refresh-all', requireAdmin, refreshAllSSProductsHandler); // Nightly price+size refresh
router.post('/import-json', requireAdmin, importFromJson);                 // PDF/ChatGPT JSON bulk import

module.exports = router;
