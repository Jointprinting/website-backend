require('dotenv').config();
const xml2js = require('xml2js');
const axios = require('axios');
const qs = require('qs');
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
        // Create the basic auth header
        //console.log(`https://dev.alphabroder.com/cgi-bin/online/xml/prod-detail-request.w?sr=${req.body.styleCode}&userName=${process.env.AB_USER}&password=${process.env.AB_PASSWORD}&rg=y`)
        //return
        // Make the GET request
        const {data} = await axios.get(`https://dev.alphabroder.com/cgi-bin/online/xml/prod-detail-request.w?sr=${req.body.styleCode}&userName=${process.env.AB_USER}&password=${process.env.AB_PASSWORD}&rg=y`, {
            auth: {
                username: process.env.AB_BASIC_AUTH_USER,
                password: process.env.AB_BASIC_AUTH_PASSWORD
            }
        });
        //console.log('auth', process.env.AB_BASIC_AUTH_USER, process.env.AB_BASIC_AUTH_PASSWORD, process.env.AB_USER, process.env.AB_PASSWORD)
        console.log('data', data)
        
        const product = await parseProductXML(data, req);
        //if product is a string send as error message
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

function capitalizeFirstLetters(sentence) {
    return sentence.split(' ').map(word => {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
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
  
    // Check if product data exists
    const products = productData.products;
    if (!products || !products.item) {
        //check if error exists in products
        if (products.error) {
            console.log('XML error:', products.error);
            return products.error;
        }
      console.error('No product data found in XML');
      return;
    }
  
    const item = products.item;
  
    // Map fields from XML to Mongoose schema
    let name = item.shortdescription || '';
    const vendor = item.brand || 'Joint Printing';
    const style = item.stylecode || '';
    let description = item.catalogdescription || '';
    // Split the string into an array based on spaces

    // Filter out items that contain # or &
    let filteredArr = description.split(" ").filter(item => !item.includes("#") && !item.includes("&"));

    // Join the array back into a string with spaces
    description = filteredArr.join(" ");

    // Escape special characters in vendor name (like the + symbol)
    const escapedVendor = vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Remove vendor and style from name
    name = name.replace(new RegExp(escapedVendor, 'g'), '').replace(/\s+/g, ' ').trim();
    name = name.replace(new RegExp(style, 'g'), '').replace(/\s+/g, ' ').trim();
    // Sizes
    let sizeNames = [];
    if (item.sizes && item.sizes.size) {
      const sizes = Array.isArray(item.sizes.size) ? item.sizes.size : [item.sizes.size];
      sizeNames = sizes.map(size => size.sizename);
    }
    const sizeRangeBottom = sizeNames[0] || 'S';
    const sizeRangeTop = sizeNames[sizeNames.length - 1] || 'XL';
  
    // Colors, Color Codes, Images
    let colors = [];
    let colorCodes = [];
    let productFrontImages = [];
    let productBackImages = [];
    
    if (item.colors && item.colors.color) {
        const colorArray = Array.isArray(item.colors.color) ? item.colors.color : [item.colors.color];
    
        for (const color of colorArray) {
            colors.push(capitalizeFirstLetters(color?.colorname));
            console.log('color', color?.colorname)

            if (color.hexcode) {
                let hex = color.hexcode;
                // Ensure the hex code starts with '#'
                if (!hex.startsWith('#')) {
                    hex = '#' + hex;
                }
                colorCodes.push(hex.toUpperCase()); // Optional: convert to uppercase for consistency
            }
          // ... processing color ...
    
          if (color['image-front']) {
            /*let frontImage = await convertToImgur(color['image-front']);
            if (!frontImage || frontImage === 'Error processing image')*/
            frontImage = color['image-front']
            productFrontImages.push(frontImage);
          } else {
            productFrontImages.push('');
          }
    
          if (color['image-back']) {
            /*let backImage = await convertToImgur(color['image-back']);
            if (!backImage || backImage === 'Error processing image')*/
            backImage = color['image-back']
            productBackImages.push(backImage);
            await delay(3000);
          } else {
            productBackImages.push('');
          }
        }
      }
  
    // Category
    let category = 'Shirts'; // Default value
    if (item.categories && item.categories.category) {
      category = item.categories.category.mktcategorydesc || 'Shirts';
    }
  
    // Create the product document
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
      // Other fields will use default values from the schema
    });
  
    // Save the product to the database
    try {
      console.log('Saving product...');
      console.log(product);
      await product.save();
      console.log('Product saved successfully');
      return product
    } catch (err) {
      console.error('Error saving product:', err);
    }
  }

  async function convertToImgur(imageUrl) {
    const data = qs.stringify({
      image: imageUrl,
      type: 'URL',
      title: 'Simple upload',
      description: 'This is a simple image upload to Imgur',
    });
  
    const config = {
      method: 'post',
      url: 'https://api.imgur.com/3/image',
      headers: {
        'Authorization': `Client-ID ${process.env.IMGUR_CLIENT_ID}`,
        //'Authorization': `Bearer ${process.env.IMGUR_ACCESS_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: data,
    };
  
    try {
      const res = await axios(config);
      if (res.data && res.data.data && res.data.data.link) {
        console.log(res.data.data.link);
        return res.data.data.link;
      } else {
        return 'Error processing image';
      }
    } catch (error) {
      console.error('Upload failed:', error.response ? error.response.data : error.message?.data?.error);
      return 'Error processing image';
    }
  }
  
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }