// routes/promoProductRoutes.js — the promo catalog behind the Quoter's promo
// picker (/api/promo-products). Owner-only.

const express = require('express');
const router = express.Router();

const { listPromoProducts, importPromoCatalog, patchPromoProduct } = require('../controllers/promoProducts');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get  ('/',        listPromoProducts);
router.post ('/import',  importPromoCatalog);
router.patch('/:id',     patchPromoProduct);

module.exports = router;
