'use strict';

// Storage layer. Uses libSQL, which speaks two dialects of the same SQLite:
//  - DATABASE_URL unset      -> a local file (./data/xenoking.db). Good for dev
//                               and for servers with a persistent disk.
//  - DATABASE_URL=libsql://… -> Turso (free cloud SQLite). Use this on hosts
//                               with an ephemeral filesystem (e.g. Render free)
//                               so the user list survives restarts/redeploys.
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
let url = DATABASE_URL;
if (!url) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  url = 'file:' + path.join(dataDir, 'xenoking.db');
}

const db = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

async function init() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password     TEXT NOT NULL,
      name         TEXT DEFAULT '',
      role         TEXT NOT NULL DEFAULT 'user',   -- 'owner' | 'user'
      status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'banned' | 'blocked'
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_login   TEXT,
      expires_at   TEXT             -- NULL = unlimited access
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`);
  // Migrate older databases that predate the expires_at column.
  try { await db.execute('ALTER TABLE users ADD COLUMN expires_at TEXT'); }
  catch (e) { /* column already exists */ }
}

const one = (rs) => (rs.rows.length ? rs.rows[0] : undefined);
const USER_COLS = 'id, email, name, role, status, created_at, updated_at, last_login, expires_at';

module.exports = {
  db,
  init,
  storageLabel: DATABASE_URL ? 'cloud (libsql)' : url,
  getUserByEmail: async (email) =>
    one(await db.execute({ sql: 'SELECT * FROM users WHERE email = ? COLLATE NOCASE', args: [email] })),
  getUserById: async (id) =>
    one(await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] })),
  createUser: async ({ email, password, name, role, status }) =>
    db.execute({
      sql: 'INSERT INTO users (email, password, name, role, status) VALUES (?, ?, ?, ?, ?)',
      args: [email, password, name, role, status],
    }),
  listUsers: async () =>
    (await db.execute(`SELECT ${USER_COLS} FROM users ORDER BY created_at DESC`)).rows,
  // Set status; optionally set expiry too. Pass expiresAt === undefined to
  // leave the expiry column untouched, or null to clear it (unlimited).
  setUserStatus: async (id, status, expiresAt) => {
    if (expiresAt === undefined) {
      return db.execute({ sql: "UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?", args: [status, id] });
    }
    return db.execute({
      sql: "UPDATE users SET status = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?",
      args: [status, expiresAt, id],
    });
  },
  setExpiry: async (id, expiresAt) =>
    db.execute({ sql: "UPDATE users SET expires_at = ?, updated_at = datetime('now') WHERE id = ?", args: [expiresAt, id] }),
  markLogin: async (id) =>
    db.execute({ sql: "UPDATE users SET last_login = datetime('now'), updated_at = datetime('now') WHERE id = ?", args: [id] }),
  deleteUser: async (id) =>
    db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] }),
  getSetting: async (key) => {
    const row = one(await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] }));
    return row ? row.value : null;
  },
  setSetting: async (key, value) =>
    db.execute({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [key, value == null ? '' : String(value)],
    }),
  upsertOwner: async function ({ email, passwordHash, name }) {
    const existing = await this.getUserByEmail(email);
    if (existing) {
      await db.execute({
        sql: "UPDATE users SET password = ?, role = 'owner', status = 'approved', updated_at = datetime('now') WHERE id = ?",
        args: [passwordHash, existing.id],
      });
      return this.getUserById(existing.id);
    }
    const info = await db.execute({
      sql: "INSERT INTO users (email, password, name, role, status) VALUES (?, ?, ?, 'owner', 'approved')",
      args: [email, passwordHash, name || 'Owner'],
    });
    return this.getUserById(Number(info.lastInsertRowid));
  },
};
