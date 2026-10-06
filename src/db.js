'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/** Each entry runs once, in order. The number of applied entries is stored in PRAGMA user_version. */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    uid TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE wallets (
    uid TEXT PRIMARY KEY,
    coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
    win_coins INTEGER NOT NULL DEFAULT 0 CHECK (win_coins >= 0 AND win_coins <= coins),
    updated_at INTEGER NOT NULL
  );
  -- Append-only history of every coin change. (type, ref) is unique: the same event can never be applied twice.
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    type TEXT NOT NULL,
    ref TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (type, ref)
  );
  CREATE INDEX ledger_uid ON ledger (uid, id DESC);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- id = SHA-256 of the payment screenshot: the same screenshot can never be submitted twice.
  CREATE TABLE deposits (
    id TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    thumb TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by TEXT
  );
  CREATE INDEX deposits_uid ON deposits (uid, created_at DESC);
  CREATE INDEX deposits_status ON deposits (status, created_at DESC);
  CREATE TABLE deposit_proofs (
    id TEXT PRIMARY KEY REFERENCES deposits (id),
    uid TEXT NOT NULL,
    img TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const done = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = done; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

/** Runs fn inside one transaction (all or nothing). BEGIN IMMEDIATE = nobody else writes meanwhile. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw e;
  }
}

module.exports = { open, tx };
