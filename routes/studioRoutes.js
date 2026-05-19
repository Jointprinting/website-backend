const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { listItems, saveItem, deleteItem, deleteByRemoteId } = require('../controllers/studioLibrary');

router.use(requireAdmin);

router.get('/library/:store',             listItems);
router.post('/library/:store',            saveItem);
router.delete('/library/item/:id',        deleteItem);
router.delete('/library/remote/:remoteId', deleteByRemoteId);

module.exports = router;
