// gridfs.js
const mongoose = require('mongoose');

let gfs; // This will store the GridFS bucket instance (bucketName: "images")

mongoose.connection.once('open', () => {
    // Use the connection's OWN database (the one named in the MongoDB URI), NOT a
    // hardcoded "test". With the literal "test" every image read/write landed in a
    // `test` database while the rest of the app used the real one — so uploaded
    // images silently went missing on any deployment whose URI isn't `.../test`.
    const db = mongoose.connection.db;
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
