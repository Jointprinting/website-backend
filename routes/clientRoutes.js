const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { listClients, getOrCreate, upsert } = require('../controllers/clients');

router.use(requireAdmin);

router.get('/',               listClients);
router.get('/:companyKey',    getOrCreate);
router.put('/:companyKey',    upsert);

module.exports = router;
