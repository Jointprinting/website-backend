const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listOrders, listClients, getOrder, createOrder, updateOrder, deleteOrder, listByCompany,
} = require('../controllers/orders');

router.use(requireAdmin);

router.get('/clients',          listClients);
router.get('/company/:name',    listByCompany);
router.get('/',                 listOrders);
router.get('/:id',              getOrder);
router.post('/',                createOrder);
router.put('/:id',              updateOrder);
router.delete('/:id',           deleteOrder);

module.exports = router;
