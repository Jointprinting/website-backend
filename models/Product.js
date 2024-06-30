const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({ 
    name: {
        type: String,
        // required: true
    },
    vendor: {
        type: String,
        default: 'Joint Printing',
    },
    style: {
        type: String,
        unique: true,
        // required: true
    },
    description: {
        type: String,
        // required: true
    },
    sizeRangeBottom: {
        type: String,
        default: 'S'
    },
    sizeRangeTop: {
        type: String,
        default: 'XL'
    },
    priceRangeBottom: {
        type: Number,
        default: 20
    },
    priceRangeTop: {
        type: Number,
        default: 28
    },
    colors: [
        {
            type: String
        }
    ],
    colorCodes: [
        {
            type: String
        }
    ],
    productFrontImages: [
        {
            type: String
        }
    ],
    productBackImages: [
        {
            type: String
        }
    ],
    rating: {
        type: Number,
        default: 5
    },
    tag: {
        type: String,
        default: 'New Arrival'
    },
    category: {
        type: String,
        default: 'Shirts'
    },
    type: {
        type: String,
        default: 'Unisex'
    },
    createdAt: {
        type: Date,
        default: Date.now()
    },
});

ProductSchema.pre("save", async function(next) {
    // Function to generate a random 4-character style code
    function generateStyleCode() {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const numbers = "0123456789";
        let style = "";
        for (let i = 0; i < 2; i++) {
            style += letters.charAt(Math.floor(Math.random() * letters.length));
        }
        for (let i = 0; i < 2; i++) {
            style += numbers.charAt(Math.floor(Math.random() * numbers.length));
        }
        return style;
    }

    let style = generateStyleCode();
    let product = await this.constructor.findOne({ style });

    // Keep generating a new style code until a unique one is found
    while (product) {
        style = generateStyleCode();
        product = await this.constructor.findOne({ style });
    }

    this.style = style;
    next();
});

const Product = mongoose.model("Product", ProductSchema);

module.exports = Product;