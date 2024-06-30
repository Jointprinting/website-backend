const express = require('express');
const router = express.Router();

const { getProducts, getProductById, getProductByStyleCode, createProduct } = require('../controllers/product');

router.get("/", getProducts);
router.get("/:id", getProductById);
router.get("/style/:style", getProductByStyleCode);
router.post("/add", createProduct);

module.exports = router;