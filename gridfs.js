// gridfs.js
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

let gfs; // This will store the GridFS bucket instance

mongoose.connection.once('open', () => {
    const db = mongoose.connection.client.db("test");
    console.log('MongoDB connection is open');
    gfs = new mongoose.mongo.GridFSBucket(db, {
        bucketName: "images",
    });
});

function getGfs() {
    if (!gfs) {
        throw new Error('GridFSBucket is not initialized');
    }
    return gfs;
}

module.exports = { getGfs };
