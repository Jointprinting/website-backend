const express = require('express');
const multer  = require('multer');
const path    = require('path');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listOrders, listClients, getOrder, createOrder, updateOrder, deleteOrder,
  listByCompany, seedHistorical, nextOrderNumber, uploadFile, deleteFile, serveFile,
  importQuotes,
} = require('../controllers/orders');

router.use(requireAdmin);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename:    (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/seed-historical',           seedHistorical);
router.post('/import-quotes',             importQuotes);
router.get('/next-number',                nextOrderNumber);
router.get('/clients',                    listClients);
router.get('/company/:name',              listByCompany);
router.get('/',                           listOrders);
router.get('/:id',                        getOrder);
router.post('/',                          createOrder);
router.put('/:id',                        updateOrder);
router.delete('/:id',                     deleteOrder);
router.post('/:id/files', upload.single('file'), uploadFile);
router.get('/:id/files/:filename',        serveFile);
router.delete('/:id/files/:filename',     deleteFile);

module.exports = router;
