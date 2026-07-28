// routes/promoProductRoutes.js — the promo catalog behind the Quoter's promo
// picker (/api/promo-products). Owner-only.

const express = require('express');
const router = express.Router();

const {
  listPromoProducts, importPromoCatalog, patchPromoProduct, estimateQuoteShipping,
} = require('../controllers/promoProducts');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get  ('/',        listPromoProducts);
router.post ('/import',  importPromoCatalog);
// Ballpark freight for a set of promo quote lines (the Quoter autofills each
// line's shippingCost from this) — see services/promoShipping.js.
router.post ('/shipping-estimate', estimateQuoteShipping);
router.patch('/:id',     patchPromoProduct);

module.exports = router;
