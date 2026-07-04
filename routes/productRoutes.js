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
  debugSSStyle,
  findSSStyle,
  dropGridfsAndStaleSync,
} = require('../controllers/product');

const { requireAdmin } = require('../middleware/auth');

// Public reads
router.get('/', getProducts);
router.get('/categories', getCategories);
router.get('/types', getTypes);
router.get('/ss/brands', getSSBrands);
router.get('/ss/browse', browseSS);
router.get('/ss/images', getSSImages);                  // legacy fallback
router.get('/ss/details', getSSDetails);                // Mongo-backed batch enrichment
// Owner diagnostics only — each fans out many calls to the METERED S&S upstream
// and returns raw supplier rows (incl. wholesale piecePrice). Admin-gated so a
// random visitor can't run up the bill or read cost data (the public site calls
// neither). The other cost-incurring upstream ops (/ss/sync etc.) are already gated.
router.get('/ss/test', requireAdmin, testSSConnection);
router.get('/ss/debug', requireAdmin, debugSSStyle);    // ?style=X — see raw S&S responses
router.get('/ss/find', findSSStyle);
router.get('/ss/style/:style', getSSStyleDetail);       // honest live fallback
router.get('/style/:style', getProductByStyleCode);     // Mongo -> sync -> fallback
router.get('/:id', getProductById);

// Admin writes — require studio token
router.post('/add', requireAdmin, createProduct);
router.post('/ss/sync', requireAdmin, syncFromSS);
router.post('/ss/refresh-all', requireAdmin, refreshAllSSProductsHandler);
router.post('/ss/warm-all', requireAdmin, warmAllStylesHandler);
router.post('/ss/drop-gridfs', requireAdmin, dropGridfsAndStaleSync); // one-time cleanup
router.post('/import-json', requireAdmin, importFromJson);

module.exports = router;
