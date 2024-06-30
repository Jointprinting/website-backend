const Product = require('../models/Product');

//get all products in db
exports.getProducts = async (req, res, next) => { 
    try {
        const products = await Product.find();
        res.status(200).json(products);
    } catch (err) {
        res.status(500).json({ message: err.message });
        console.error(err);
    }
}

exports.getProductById = async (req, res, next) => {
    try {
        const product = await Product.findById(req.params.id);
        res.status(200).json(product);
    } catch (err) {
        res.status(404).json({ message: err.message });
        console.error(err);
    }
}

exports.getProductByStyleCode = async (req, res, next) => {
    try {
        const product = await Product.findOne({ style: req.params.style });
        res.status(200).json(product);
    } catch (err) {
        res.status(404).json({ message: err.message });
        console.error(err);
    }
}

//create a new product
exports.createProduct = async (req, res, next) => {
    console.log('adding product')
    try {
        const newProduct = new Product({
            name: req.body.name,
            vendor: req.body.vendor,
            style: req.body.style,
            description: req.body.description,
            sizeRangeBottom: req.body.sizeRangeBottom,
            sizeRangeTop: req.body.sizeRangeTop,
            priceRangeBottom: req.body.priceRangeBottom,
            priceRangeTop: req.body.priceRangeTop,
            colors: req.body.colors,
            colorCodes: req.body.colorCodes,
            productFrontImages: req.body.productFrontImages,
            productBackImages: req.body.productBackImages,
            rating: req.body.rating,
            tag: req.body.tag,
            category: req.body.category,
            type: req.body.type,
        });
        await newProduct.save();
        res.status(201).json(newProduct);
    } catch (err) {
        res.status(400).json({ message: err.message });
        console.error(err);
    }
}