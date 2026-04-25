#!/usr/bin/env node
// scripts/setStudioPassword.js
//
// One-time setup: create or reset the studio password.
//
//   Usage:
//     STUDIO_NEW_PASSWORD='a-strong-password' node scripts/setStudioPassword.js
//
//   Or, omit STUDIO_NEW_PASSWORD and you'll be prompted interactively.
//
// Run this on the server after deploy. The password is hashed with bcrypt
// (cost 12) and stored in the AdminUser collection in Mongo.

require('dotenv').config();
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const readline = require('readline');
const AdminUser = require('../models/AdminUser');

async function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('❌ MONGO_URI is not set in env.');
    process.exit(1);
  }

  let pw = process.env.STUDIO_NEW_PASSWORD;
  if (!pw) {
    pw = await prompt('New studio password: ');
  }
  if (!pw || pw.length < 10) {
    console.error('❌ Password must be at least 10 characters.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to Mongo.');

  const passwordHash = await bcrypt.hash(pw, 12);

  const result = await AdminUser.findOneAndUpdate(
    { username: 'studio' },
    {
      $set: { passwordHash, failedLoginAttempts: 0 },
      $unset: { lockedUntil: 1 },
      $setOnInsert: { username: 'studio', createdAt: new Date() },
    },
    { upsert: true, new: true }
  );

  console.log(`✅ Studio password set for user "${result.username}".`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
