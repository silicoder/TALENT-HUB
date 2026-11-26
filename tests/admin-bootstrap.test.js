'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { verifyPassword } = require('../src/security');

const scriptPath = path.join(__dirname, '..', 'scripts', 'create-admin.js');

test('admin bootstrap creates only the explicitly configured administrator', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-hub-admin-'));
  const databasePath = path.join(tempDir, 'bootstrap.sqlite');
  const password = 'UniqueStrongAdminPassword!2026';
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        ADMIN_EMAIL: 'bootstrap-admin@example.test',
        ADMIN_PASSWORD: password
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const db = openDatabase(databasePath);
    try {
      const users = db.prepare('SELECT email, password_hash, role FROM users').all();
      assert.equal(users.length, 1);
      assert.equal(users[0].email, 'bootstrap-admin@example.test');
      assert.equal(users[0].role, 'admin');
      assert.notEqual(users[0].password_hash, password);
      assert.equal(await verifyPassword(password, users[0].password_hash), true);
    } finally { db.close(); }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('admin bootstrap refuses a password shorter than 16 characters', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-hub-admin-invalid-'));
  const databasePath = path.join(tempDir, 'bootstrap.sqlite');
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        ADMIN_EMAIL: 'bootstrap-admin@example.test',
        ADMIN_PASSWORD: 'short-pass'
      }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /at least 16 characters/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
