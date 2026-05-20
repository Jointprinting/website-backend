const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listQuotes, getQuote, createQuote, updateQuote, deleteQuote,
  getClients, suggestTiers, lookupStyle, createNotionOrder,
} = require('../controllers/quoter');

router.use(requireAdmin);

router.get('/quotes',            listQuotes);
router.get('/quotes/:id',        getQuote);
router.post('/quotes',           createQuote);
router.put('/quotes/:id',        updateQuote);
router.delete('/quotes/:id',     deleteQuote);

router.get('/clients',           getClients);
router.get('/suggest',           suggestTiers);
router.get('/style/:styleCode',  lookupStyle);
router.post('/notion-order',     createNotionOrder);

module.exports = router;
