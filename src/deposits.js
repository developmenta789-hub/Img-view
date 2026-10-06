'use strict';
const crypto = require('node:crypto');
const { tx } = require('./db');
const { applyCoins } = require('./wallet');
const { HttpError, bad, forbidden, conflict } = require('./errors');

const UPI_RE = /^[A-Za-z0-9._-]{2,60}@[A-Za-z0-9]{2,30}$/;
const ID_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ---------- settings (payment details, on/off, daily limit) ----------
function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, value, Date.now());
}
function delSetting(db, key) { db.prepare('DELETE FROM settings WHERE key = ?').run(key); }

function getPaymentInfo(db) {
  const v = getSetting(db, 'paymentInfo');
  if (!v) return null;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function setPaymentInfo(db, body) {
  const upiId = typeof body.upiId === 'string' ? body.upiId.trim() : '';
  if (!UPI_RE.test(upiId)) throw bad('bad_upi', 'Enter a valid UPI ID, for example name@bank.');
  let qrUrl = '';
  if (body.qrUrl !== undefined && body.qrUrl !== null && body.qrUrl !== '') {
    qrUrl = typeof body.qrUrl === 'string' ? body.qrUrl.trim() : '';
    if (!qrUrl.startsWith('https://') || qrUrl.length > 500) throw bad('bad_qr', 'QR link must start with https:// (max 500 characters).');
  }
  const info = { slot: 'deposit', upiId, qrUrl, updatedAt: Date.now() };
  setSetting(db, 'paymentInfo', JSON.stringify(info));
  return info;
}

function getDepositOn(db) { return getSetting(db, 'depositOn') !== '0'; }
function getDailyLimit(db, cfg) {
  const v = getSetting(db, 'depositDailyLimit');
  return v === null ? cfg.depositDailyLimit : Math.max(0, Number.parseInt(v, 10) || 0);
}

function setDepositSettings(db, body) {
  if (body.depositOn !== undefined) {
    if (typeof body.depositOn !== 'boolean') throw bad('bad_value', 'depositOn must be true or false.');
    setSetting(db, 'depositOn', body.depositOn ? '1' : '0');
  }
  if (body.dailyLimit !== undefined) {
    const n = body.dailyLimit;
    if (!Number.isSafeInteger(n) || n < 0 || n > 10000000) throw bad('bad_value', 'dailyLimit must be a whole number from 0 to 10000000.');
    setSetting(db, 'depositDailyLimit', String(n));
  }
}

// ---------- helpers ----------
/** Start of "today" in the configured time zone (default India, UTC+5:30), as a UTC ms timestamp. */
function startOfDay(cfg, now = Date.now()) {
  const off = cfg.tzOffsetMin * 60000;
  const local = now + off;
  return local - (((local % 86400000) + 86400000) % 86400000) - off;
}

function usedToday(db, cfg, uid) {
  const r = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM deposits WHERE uid = ? AND status != 'rejected' AND created_at >= ?").get(uid, startOfDay(cfg));
  return r.s;
}

function minAmount(cfg, limit) { return limit > 0 && limit < cfg.depositMin ? 1 : cfg.depositMin; }

/** Everything the deposit screen needs, in one call. */
function depositConfig(db, cfg, uid) {
  const limit = getDailyLimit(db, cfg);
  const pi = getPaymentInfo(db);
  return {
    depositOn: getDepositOn(db),
    dailyLimit: limit,
    usedToday: usedToday(db, cfg, uid),
    min: minAmount(cfg, limit),
    max: cfg.depositMax,
    upiId: pi ? pi.upiId : '',
    qrUrl: pi ? pi.qrUrl : '',
  };
}

function decodeJpeg(value, maxBytes, field) {
  if (typeof value !== 'string' || value.length < 100 || value.length > Math.ceil(maxBytes * 4 / 3) + 8 || !B64_RE.test(value)) throw bad('bad_image', 'Invalid ' + field + '.');
  const buf = Buffer.from(value, 'base64');
  if (buf.length < 100 || buf.length > maxBytes) throw bad('bad_image', 'Invalid ' + field + '.');
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw bad('bad_image', 'The ' + field + ' must be a JPEG image.');
  return buf;
}

const rowOut = (r) => ({ id: r.id, uid: r.uid, name: r.name, amount: r.amount, status: r.status, thumb: r.thumb, createdAt: r.created_at, reviewedAt: r.reviewed_at });

// ---------- user: submit a deposit ----------
function createDeposit(db, cfg, user, body) {
  const amount = typeof body.amount === 'string' && /^[0-9]{1,8}$/.test(body.amount) ? Number(body.amount) : body.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw bad('bad_amount', 'Enter a whole amount.');
  const img = decodeJpeg(body.img, cfg.maxImgBytes, 'screenshot');
  decodeJpeg(body.thumb, cfg.maxThumbBytes, 'thumbnail');
  // The id is made by the SERVER from the screenshot itself; a hash sent by the app is never trusted.
  const id = crypto.createHash('sha256').update(img).digest('hex');
  const name = (user.name || 'Player').trim().slice(0, 100) || 'Player';

  return tx(db, () => {
    if (!getDepositOn(db)) throw forbidden('deposit_off', 'Add Money Request is currently unavailable. Please try again later.');
    if (!getPaymentInfo(db)) throw new HttpError(503, 'no_payment_info', 'UPI payment details unavailable. Please try again later.');
    const limit = getDailyLimit(db, cfg);
    const min = minAmount(cfg, limit);
    if (amount < min || amount > cfg.depositMax) throw bad('bad_amount', `Enter an amount from ${min} to ${cfg.depositMax}.`);
    if (limit > 0) {
      const left = Math.max(0, limit - usedToday(db, cfg, user.uid));
      if (amount > left) throw new HttpError(400, 'limit_exceeded', `You can deposit only up to ${limit} per day. Left today: ${left}.`);
    }
    const pending = db.prepare("SELECT COUNT(*) AS c FROM deposits WHERE uid = ? AND status = 'pending'").get(user.uid).c;
    if (pending >= cfg.depositMaxPending) throw new HttpError(429, 'too_many_pending', 'You already have several pending deposits. Wait until they are checked.');
    const now = Date.now();
    db.prepare('INSERT OR IGNORE INTO users (uid, name, created_at) VALUES (?,?,?)').run(user.uid, name, now);
    try {
      db.prepare("INSERT INTO deposits (id, uid, name, amount, status, thumb, created_at) VALUES (?,?,?,?, 'pending', ?, ?)").run(id, user.uid, name, amount, body.thumb, now);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e.message))) throw conflict('duplicate_screenshot', 'This screenshot was already submitted.');
      throw e;
    }
    db.prepare('INSERT INTO deposit_proofs (id, uid, img, created_at) VALUES (?,?,?,?)').run(id, user.uid, body.img, now);
    return { id, status: 'pending', amount, createdAt: now };
  });
}

function listMine(db, uid, limit) {
  const n = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 30));
  return db.prepare('SELECT id, amount, status, created_at, reviewed_at FROM deposits WHERE uid = ? ORDER BY created_at DESC LIMIT ?').all(uid, n)
    .map((r) => ({ id: r.id, amount: r.amount, status: r.status, createdAt: r.created_at, reviewedAt: r.reviewed_at }));
}

// ---------- owner ----------
function adminList(db, status, limit) {
  const n = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 100));
  const rows = ['pending', 'approved', 'rejected'].includes(status)
    ? db.prepare('SELECT * FROM deposits WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, n)
    : db.prepare("SELECT * FROM deposits ORDER BY (status = 'pending') DESC, created_at DESC LIMIT ?").all(n);
  return rows.map(rowOut);
}

function adminProof(db, id) {
  if (!ID_RE.test(id)) throw bad('bad_id', 'Bad request id.');
  const r = db.prepare('SELECT img FROM deposit_proofs WHERE id = ?').get(id);
  if (!r) throw new HttpError(404, 'not_found', 'Screenshot not found.');
  return { img: r.img };
}

/** Approve or reject once. Status change and coins happen in ONE transaction; approving twice is impossible. */
function review(db, adminUid, id, approve) {
  if (!ID_RE.test(id)) throw bad('bad_id', 'Bad request id.');
  return tx(db, () => {
    const d = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
    if (!d) throw new HttpError(404, 'not_found', 'Deposit not found.');
    if (d.status !== 'pending') throw conflict('not_pending', 'This request was already ' + d.status + '.');
    const now = Date.now();
    db.prepare('UPDATE deposits SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', now, adminUid, id);
    let coins = null;
    if (approve) coins = applyCoins(db, { uid: d.uid, delta: d.amount, type: 'deposit', ref: id, note: 'Deposit approved' });
    return { id, status: approve ? 'approved' : 'rejected', coins };
  });
}

module.exports = {
  depositConfig, createDeposit, listMine, adminList, adminProof, review,
  getPaymentInfo, setPaymentInfo, delSetting, setDepositSettings, startOfDay,
};
