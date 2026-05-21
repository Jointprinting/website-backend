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
  getSSImages,
  getSSDetails,
  testSSConnection,
  warmAllStylesHandler,
} = require('../controllers/product');

const { requireAdmin } = require('../middleware/auth');

// Public reads
router.get('/', getProducts);
router.get('/categories', getCategories);
router.get('/types', getTypes);
router.get('/ss/brands', getSSBrands);
router.get('/ss/browse', browseSS);
router.get('/ss/images', getSSImages);              // batch per-style image URL lookup
router.get('/ss/details', getSSDetails);            // batch per-style price/size/colorCount lookup
router.get('/ss/test', testSSConnection);           // credential + connectivity check
router.get('/ss/style/:style', getSSStyleDetail);   // live S&S detail (fallback when sync fails)
router.get('/style/:style', getProductByStyleCode); // Mongo → on-demand sync → live fallback
router.get('/:id', getProductById);

// Admin writes — require studio token
router.post('/add', requireAdmin, createProduct);                          // Alpha Broder fallback
router.post('/ss/sync', requireAdmin, syncFromSS);                         // S&S Activewear smart sync (batch)
router.post('/ss/refresh-all', requireAdmin, refreshAllSSProductsHandler); // Nightly price+size refresh
router.post('/ss/warm-all', requireAdmin, warmAllStylesHandler);           // Kick off full per-style catalog warm
router.post('/import-json', requireAdmin, importFromJson);                 // PDF/ChatGPT JSON bulk import

module.exports = router;
