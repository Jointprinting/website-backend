require('dotenv').config();
const xml2js = require('xml2js');
const axios = require('axios');
const Product = require('../models/Product');
const { getGfs } = require('../gridfs');
const sharp = require('sharp');

//get all products in db
exports.getProducts = async (req, res, next) => { 
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 12;
        const skip = (page - 1) * limit;

        // Extract category and type from query parameters
        const { category, type } = req.query;

        // Build the query object based on the provided filters
        const query = {};
        if (category) query.category = category;
        if (type) query.type = type;
 
        const products = await Product.find(query).skip(skip).limit(limit);
        if (!products.length) return res.status(404).json({ products: [], totalPages: 0 });
        const totalProducts = await Product.countDocuments(query);

        // Fetch and convert images for each product
        const productsWithImages = await Promise.all(
            products.map(async (product) => {
                const productWithImages = {
                    ...product.toObject(),
                    productFrontImages: [await getImageFromGridFS(product.productFrontImages[0])],
                    productBackImages: [await getImageFromGridFS(product.productBackImages[0])],
                };
                return productWithImages;
            })
        );

        res.status(200).json({ products: productsWithImages, totalPages: Math.ceil(totalProducts / limit) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
};

// Helper function to fetch and convert image from GridFS to base64
async function getImageFromGridFS(imageId) {
    if (!imageId) return null;

    return new Promise((resolve, reject) => {
        const gfs = getGfs();
        const downloadStream = gfs.openDownloadStream(imageId);
        const chunks = [];

        downloadStream.on('data', (chunk) => chunks.push(chunk));
        downloadStream.on('end', () => {
            const base64Image = `data:image/webp;base64,${Buffer.concat(chunks).toString('base64')}`;
            resolve(base64Image);
        });
        downloadStream.on('error', (err) => {
            console.error(`Error retrieving image with ID ${imageId}:`, err.message);
            reject(null);
        });
    });
}



exports.getProductById = async (req, res, next) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });

        const productWithImages = await populateImages(product);
        res.status(200).json(productWithImages);
    } catch (err) {
        res.status(404).json({ message: err.message });
        console.error(err);
    }
};

exports.getProductByStyleCode = async (req, res, next) => {
    try {
        const product = await Product.findOne({ style: req.params.style });
        if (!product) return res.status(404).json({ message: 'Product not found' });
         // Convert image buffers to Base64
         const productWithImages = await populateImages(product);
        
        res.status(200).json(productWithImages);
    } catch (err) {
        res.status(404).json({ message: err.message });
        console.error(err);
    }
}

exports.getCategories = async (req, res, next) => {
    try {
        const categories = await Product.distinct('category');
        res.status(200).json({ categories });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to fetch categories' });
    }
}

exports.getTypes = async (req, res, next) => {
    try {
        const types = await Product.distinct('type');
        res.status(200).json({ types });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to fetch types' });
    }
}

exports.createProduct = async (req, res, next) => {
    console.log('adding product');

    try {
        const { data } = await axios.get(`https://dev.alphabroder.com/cgi-bin/online/xml/prod-detail-request.w?sr=${req.body.styleCode}&userName=${process.env.AB_USER}&password=${process.env.AB_PASSWORD}&rg=y`, {
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
    
    const item = productData.products?.item;
    if (!item) return 'No product data found in XML';

    // Extract product info
    let name = item.shortdescription || '';
    const vendor = item.brand || 'Joint Printing';
    const style = item.stylecode || '';
    let description = item.catalogdescription || '';

    // Clean description
    description = description.split(" ").filter(word => !word.includes("#") && !word.includes("&")).join(" ");

    name = name.replace(new RegExp(vendor, 'g'), '').replace(/\s+/g, ' ').trim();
    name = name.replace(new RegExp(style, 'g'), '').replace(/\s+/g, ' ').trim();
    //replace all extra spaces with one space
    name = name.replace(/\s+/g, ' ').trim();

    let sizeNames = [];
    if (item.sizes && item.sizes[0] && item.sizes[0].size) {
        const sizes = Array.isArray(item.sizes[0].size) ? item.sizes[0].size : [item.sizes[0].size];
        //console.log('sizes:', sizes);
        sizeNames = sizes.map(size => size.sizename);
    }
    const sizeRangeBottom = sizeNames[0] || 'S';
    const sizeRangeTop = sizeNames[sizeNames.length - 1] || 'XL';

    // Extract and upload images to GridFS
    const productFrontImages = [];
    const productBackImages = [];

    let colorArray = [];
    let colorCodes = [];

    if (item.colors?.color) {
        const colors = Array.isArray(item.colors.color) ? item.colors.color : [item.colors.color];
        for (const color of colors) {
            colorArray.push(capitalizeFirstLetters(color?.colorname));
            if (color.hexcode) {
                let hex = color.hexcode;
                if (!hex.startsWith('#')) hex = '#' + hex;
                colorCodes.push(hex.toUpperCase());
            }

            if (color['image-front']) {
                const frontImageId = await uploadImageToGridFS(color['image-front'].replace('dev-wam.', ''));
                productFrontImages.push(frontImageId);
            } else {
                productFrontImages.push(null);
            }

            if (color['image-back']) {
                const backImageId = await uploadImageToGridFS(color['image-back'].replace('dev-wam.', ''));
                productBackImages.push(backImageId);
            } else {
                productBackImages.push(null);
            }
        }
    }

    const product = new Product({
        name,
        vendor,
        style,
        description,
        sizeRangeBottom: sizeRangeBottom,
        sizeRangeTop: sizeRangeTop,
        colors: colorArray,
        colorCodes: colorCodes,
        productFrontImages,
        productBackImages,
        category: req.body.category,
        priceRangeBottom: req.body.priceRangeBottom,
        priceRangeTop: req.body.priceRangeTop,
        rating: req.body.rating,
        tag: req.body.tag,
        type: req.body.type,
    });
    
    await product.save();
    console.log('Product saved successfully');
    return product;
}

// Helper function to fetch and convert image URL to buffer
async function convertImageToBuffer(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const compressedBuffer = await sharp(response.data)
            .webp({ quality: 100 }) // Convert to WebP with a quality of 80
            .toBuffer();
        return compressedBuffer;
    } catch (err) {
        console.error(`Error fetching image: ${imageUrl}`, err);
        return null;
    }
}


async function populateImages(product) {
    const populateImage = async (imageId) => {
        if (!imageId) return null;

        const gfs = getGfs();
        const downloadStream = gfs.openDownloadStream(imageId);
        const chunks = [];
        return new Promise((resolve, reject) => {
            downloadStream.on('data', chunk => chunks.push(chunk));
            downloadStream.on('end', () => resolve(`data:image/webp;base64,${Buffer.concat(chunks).toString('base64')}`));
            downloadStream.on('error', reject);
        });
    };

    const productWithImages = {
        ...product.toObject(),
        productFrontImages: await Promise.all(product.productFrontImages.map(id => populateImage(id))),
        productBackImages: await Promise.all(product.productBackImages.map(id => populateImage(id)))
    };

    return productWithImages;
}

async function uploadImageToGridFS(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const compressedBuffer = await sharp(response.data).resize({ width: 500 }).webp({ quality: 80 }).toBuffer();
        
        const gfs = getGfs();
        const uploadStream = gfs.openUploadStream(Date.now() + '-product-image.webp');
        uploadStream.end(compressedBuffer);
        return uploadStream.id; // Store this ID in the product document
    } catch (err) {
        console.error(`Error fetching image from URL: ${imageUrl}`, err.message);
        return null;
    }
}

// Helper function to fetch and convert image from GridFS to base64
async function getImageFromGridFS(imageId) {
    if (!imageId) return null;

    return new Promise((resolve, reject) => {
        const gfs = getGfs();
        const downloadStream = gfs.openDownloadStream(imageId);
        const chunks = [];

        downloadStream.on('data', (chunk) => chunks.push(chunk));
        downloadStream.on('end', () => {
            const base64Image = `data:image/webp;base64,${Buffer.concat(chunks).toString('base64')}`;
            resolve(base64Image);
        });
        downloadStream.on('error', (err) => {
            console.error(`Error retrieving image with ID ${imageId}:`, err.message);
            reject(null);
        });
    });
}

function capitalizeFirstLetters(sentence) {
    return sentence.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}