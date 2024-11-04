require('dotenv').config();
const xml2js = require('xml2js');
const axios = require('axios');
const qs = require('qs');
const Product = require('../models/Product');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

//get all products in db
exports.getProducts = async (req, res, next) => { 
    try {
        const products = await Product.find();
        // Convert image buffers to Base64 for frontend display
        const productsWithImages = products.map(product => ({
            ...product.toObject(),
            productFrontImages: product.productFrontImages.map(img => img ? `data:image/jpeg;base64,${img.toString('base64')}` : null),
            productBackImages: product.productBackImages.map(img => img ? `data:image/jpeg;base64,${img.toString('base64')}` : null)
        }));
        res.status(200).json(productsWithImages);
    } catch (err) {
        res.status(500).json({ message: err.message });
        console.error(err);
    }
}

exports.getProductById = async (req, res, next) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });

        // Convert image buffers to Base64
        const productWithImages = {
            ...product.toObject(),
            productFrontImages: product.productFrontImages.map(img => img ? `data:image/jpeg;base64,${img.toString('base64')}` : null),
            productBackImages: product.productBackImages.map(img => img ? `data:image/jpeg;base64,${img.toString('base64')}` : null)
        };
        
        res.status(200).json(productWithImages);
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
        const {data} = await axios.get(`https://dev.alphabroder.com/cgi-bin/online/xml/prod-detail-request.w?sr=${req.body.styleCode}&userName=${process.env.AB_USER}&password=${process.env.AB_PASSWORD}&rg=y`, {
            auth: {
                username: process.env.AB_BASIC_AUTH_USER,
                password: process.env.AB_BASIC_AUTH_PASSWORD
            }
        });

        const product = await parseProductXML(data, req);
        
        if (typeof product === 'string') {
            console.log('Error:', product);
            return res.status(400).json({ message: product });
        }
        res.status(201).json(product);
    } catch (err) {
        res.status(400).json({ message: err.message });
        console.error(err);
    }
}

async function parseProductXML(xmlString, req) {
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
  
    let productData;
    try {
        productData = await parser.parseStringPromise(xmlString);
    } catch (err) {
        console.error('Error parsing XML:', err);
        return;
    }
  
    const products = productData.products;
    if (!products || !products.item) {
        if (products.error) {
            console.log('XML error:', products.error);
            return products.error;
        }
        console.error('No product data found in XML');
        return;
    }
  
    const item = products.item;
    let name = item.shortdescription || '';
    const vendor = item.brand || 'Joint Printing';
    const style = item.stylecode || '';
    let description = item.catalogdescription || '';

    // Clean description
    description = description.split(" ").filter(word => !word.includes("#") && !word.includes("&")).join(" ");

    name = name.replace(new RegExp(vendor, 'g'), '').replace(/\s+/g, ' ').trim();
    name = name.replace(new RegExp(style, 'g'), '').replace(/\s+/g, ' ').trim();
    
    let sizeNames = [];
    if (item.sizes && item.sizes.size) {
        const sizes = Array.isArray(item.sizes.size) ? item.sizes.size : [item.sizes.size];
        sizeNames = sizes.map(size => size.sizename);
    }
    const sizeRangeBottom = sizeNames[0] || 'S';
    const sizeRangeTop = sizeNames[sizeNames.length - 1] || 'XL';
  
    let colors = [];
    let colorCodes = [];
    let productFrontImages = [];
    let productBackImages = [];
    
    if (item.colors && item.colors.color) {
        const colorArray = Array.isArray(item.colors.color) ? item.colors.color : [item.colors.color];
    
        for (const color of colorArray) {
            colors.push(capitalizeFirstLetters(color?.colorname));
            if (color.hexcode) {
                let hex = color.hexcode;
                if (!hex.startsWith('#')) hex = '#' + hex;
                colorCodes.push(hex.toUpperCase());
            }
    
            if (color['image-front']) {
                const frontImageBuffer = await convertImageToBuffer(color['image-front']);
                productFrontImages.push(frontImageBuffer);
            } else {
                productFrontImages.push(null);
            }
    
            if (color['image-back']) {
                const backImageBuffer = await convertImageToBuffer(color['image-back']);
                productBackImages.push(backImageBuffer);
            } else {
                productBackImages.push(null);
            }
        }
    }
  
    let category = 'Shirts';
    if (item.categories && item.categories.category) {
        category = item.categories.category.mktcategorydesc || 'Shirts';
    }
  
    const product = new Product({
        name,
        vendor,
        style,
        description,
        sizeRangeBottom,
        sizeRangeTop,
        colors,
        colorCodes,
        productFrontImages,
        productBackImages,
        category: req.body.category,
        priceRangeBottom: req.body.priceRangeBottom,
        priceRangeTop: req.body.priceRangeTop,
        rating: req.body.rating,
        tag: req.body.tag,
        type: req.body.type,
    });
  
    try {
        console.log('Saving product...');
        await product.save();
        console.log('Product saved successfully');
        return product;
    } catch (err) {
        console.error('Error saving product:', err);
    }
}

// Helper function to fetch and convert image URL to buffer
async function convertImageToBuffer(imageUrl) {
    try {
        //if 'dev-wam.' in imageUrl, replace with ''
        imageUrl = imageUrl.replace('dev-wam.', '');
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'PostmanRuntime/7.37.3',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                // Add other headers from Postman if necessary, like 'Accept' or 'Cookie'
            }
        });
        return Buffer.from(response.data);
    } catch (err) {
        if (err.response && err.response.data) {
            // Convert buffer to a string for easier error inspection
            const errorMessage = err.response.data.toString('utf-8');
            console.error(`Error fetching image from URL: ${imageUrl}\nServer Response: ${errorMessage}`);
        } else {
            console.error(`Error fetching image from URL: ${imageUrl}`, err.message);
        }
        return null;
    }
}
  
function capitalizeFirstLetters(sentence) {
    return sentence.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}