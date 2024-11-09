const express = require('express');
const router = express.Router();

const { getProducts, getProductById, getProductByStyleCode, createProduct, getCategories, getTypes } = require('../controllers/product');

router.get("/", getProducts);
router.get("/:id", getProductById);
router.get("/style/:style", getProductByStyleCode);
router.post("/add", createProduct);
router.get("/categories", getCategories);
router.get("/types", getTypes);

module.exports = router;