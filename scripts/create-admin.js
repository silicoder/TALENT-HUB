'use strict';

const crypto = require('node:crypto');
const { openDatabase } = require('../src/db');
const { hashPassword } = require('../src/security');

(async function createAdmin() {
  try { require('node:process').loadEnvFile?.(); } catch { /* environment variables may be supplied by the shell */ }
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 16 || password.length > 128) {
    throw new Error('Set ADMIN_EMAIL to a valid email and ADMIN_PASSWORD to a unique password of at least 16 characters.');
  }
  const db = openDatabase(process.env.DATABASE_PATH || './data/talent-hub.sqlite');
  try {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('An account with that email already exists.');
    db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(crypto.randomUUID(), email, await hashPassword(password), 'admin');
    console.log(`Administrator account created for ${email}. The password was not printed.`);
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(`[create-admin] ${error.message}`);
  process.exitCode = 1;
});
