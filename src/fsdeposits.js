'use strict';
const crypto = require('node:crypto');
const { HttpError, bad, forbidden, conflict } = require('./errors');
const { planCoins } = require('./fswallet');
const { startOfDay, decodeJpeg, minAmount, UPI_RE, ID_RE } = require('./deposits');

/**
 * Deposits on Firestore. Same documents the apps already use:
 *   deposits/{sha256}        { uid, name, amount, status, thumb, createdAt, reviewedAt?, reviewedBy?, reason? }
 *   depositProofs/{sha256}   { uid, img, createdAt }          (screenshot, base64 JPEG, max 300 KB)
 *   paymentInfo/deposit      { slot:'deposit', upiId, qrUrl?, updatedAt }
 *   appInfo/main             { depositOn?, depositDailyLimit?, ... }  (only those two fields are touched here)
 * Approve = status change + coins in ONE transaction (ledger id deposit_<id>, so it can never be paid twice).
 */
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || 0);
const mine = (db, uid) => db.collection('deposits').where('uid', '==', uid);

async function settings(t, db, cfg) {
  const info = await t.get(db.collection('appInfo').doc('main'));
  const pay = await t.get(db.collection('paymentInfo').doc('deposit'));
  const a = info.exists ? info.data() : {};
  const limit = Number.isSafeInteger(a.depositDailyLimit) && a.depositDailyLimit >= 0 ? a.depositDailyLimit : cfg.depositDailyLimit;
  const p = pay.exists ? pay.data() : null;
  return { depositOn: a.depositOn !== false, limit, pay: p };
}

function usage(cfg, docs) {
  const from = startOfDay(cfg);
  let used = 0; let pending = 0;
  for (const d of docs) {
    const x = d.data();
    if (x.status === 'pending') pending++;
    if (x.status !== 'rejected' && ms(x.createdAt) >= from) used += x.amount;
  }
  return { used, pending };
}

async function depositConfig(db, cfg, uid) {
  return db.runTransaction(async (t) => {
    const s = await settings(t, db, cfg);
    const u = usage(cfg, uid ? (await t.get(mine(db, uid))).docs : []);
    return { depositOn: s.depositOn, dailyLimit: s.limit, usedToday: u.used, min: minAmount(cfg, s.limit), max: cfg.depositMax, upiId: s.pay ? s.pay.upiId : '', qrUrl: s.pay ? s.pay.qrUrl || '' : '' };
  });
}

async function createDeposit(db, cfg, user, body) {
  const amount = typeof body.amount === 'string' && /^[0-9]{1,8}$/.test(body.amount) ? Number(body.amount) : body.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw bad('bad_amount', 'Enter a whole amount.');
  const img = decodeJpeg(body.img, cfg.maxImgBytes, 'screenshot');
  decodeJpeg(body.thumb, cfg.maxThumbBytes, 'thumbnail');
  if (body.thumb.length > 30000) throw bad('bad_image', 'Invalid thumbnail.'); // same limit as Firestor.rules
  const id = crypto.createHash('sha256').update(img).digest('hex'); // made by the SERVER, a hash from the app is never trusted
  const dref = db.collection('deposits').doc(id);
  const pref = db.collection('depositProofs').doc(id);
  return db.runTransaction(async (t) => {
    const ds = await t.get(dref);
    const us = await t.get(db.collection('users').doc(user.uid));
    const s = await settings(t, db, cfg);
    const mineDocs = (await t.get(mine(db, user.uid))).docs;
    if (ds.exists) throw conflict('duplicate_screenshot', 'This screenshot was already submitted.');
    if (!us.exists || us.data().age18Plus !== true) throw forbidden('no_profile', 'Please finish signing up on the website first.');
    const u = us.data();
    const st = u.status || 'active';
    if (st === 'banned' || (st === 'suspended' && (!u.suspendedUntil || ms(u.suspendedUntil) > Date.now()))) throw forbidden('blocked', 'This account cannot deposit right now.');
    if (!s.depositOn) throw forbidden('deposit_off', 'Add Money Request is currently unavailable. Please try again later.');
    if (!s.pay) throw new HttpError(503, 'no_payment_info', 'UPI payment details unavailable. Please try again later.');
    const min = minAmount(cfg, s.limit);
    if (amount < min || amount > cfg.depositMax) throw bad('bad_amount', `Enter an amount from ${min} to ${cfg.depositMax}.`);
    const use = usage(cfg, mineDocs);
    if (s.limit > 0 && amount > Math.max(0, s.limit - use.used)) {
      throw new HttpError(400, 'limit_exceeded', `You can deposit only up to ${s.limit} per day. Left today: ${Math.max(0, s.limit - use.used)}.`);
    }
    if (use.pending >= cfg.depositMaxPending) throw new HttpError(429, 'too_many_pending', 'You already have several pending deposits. Wait until they are checked.');
    const now = new Date();
    const name = String(u.name || user.name || 'Player').trim().slice(0, 100) || 'Player';
    t.create(dref, { uid: user.uid, name, amount, status: 'pending', thumb: body.thumb, createdAt: now });
    t.create(pref, { uid: user.uid, img: body.img, createdAt: now });
    return { id, status: 'pending', amount, createdAt: now.getTime() };
  });
}

async function listMine(db, uid, limit) {
  const n = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 30));
  const q = await mine(db, uid).get();
  return q.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt)).slice(0, n)
    .map((x) => ({ id: x.id, amount: x.amount, status: x.status, reason: x.reason || '', createdAt: ms(x.createdAt), reviewedAt: x.reviewedAt ? ms(x.reviewedAt) : null }));
}

async function adminList(db, status, limit) {
  const n = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 100));
  const col = db.collection('deposits');
  const q = ['pending', 'approved', 'rejected'].includes(status) ? col.where('status', '==', status).limit(n) : col.orderBy('createdAt', 'desc').limit(n);
  const rows = (await q.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || ms(b.createdAt) - ms(a.createdAt));
  return rows.map((x) => ({ id: x.id, uid: x.uid, name: x.name, amount: x.amount, status: x.status, thumb: x.thumb, reason: x.reason || '', createdAt: ms(x.createdAt), reviewedAt: x.reviewedAt ? ms(x.reviewedAt) : null }));
}

async function adminProof(db, id) {
  if (!ID_RE.test(id)) throw bad('bad_id', 'Bad request id.');
  const s = await db.collection('depositProofs').doc(id).get();
  if (!s.exists) throw new HttpError(404, 'not_found', 'Screenshot not found.');
  return { img: s.data().img };
}

/** Approve or reject once. Rejecting needs a reason of 3 to 120 characters (the player sees it in Payvex). */
async function review(db, adminUid, id, approve, reason) {
  if (!ID_RE.test(id)) throw bad('bad_id', 'Bad request id.');
  let why = '';
  if (!approve) {
    why = typeof reason === 'string' ? reason.trim() : '';
    if (why.length < 3 || why.length > 120) throw bad('bad_reason', 'Write a reason of 3 to 120 characters.');
  }
  const dref = db.collection('deposits').doc(id);
  return db.runTransaction(async (t) => {
    const ds = await t.get(dref);
    if (!ds.exists) throw new HttpError(404, 'not_found', 'Deposit not found.');
    const d = ds.data();
    if (d.status !== 'pending') throw conflict('not_pending', 'This request was already ' + d.status + '.');
    const plan = approve ? await planCoins(t, db, { uid: d.uid, delta: d.amount, type: 'deposit', ref: id, note: 'Deposit approved' }) : null;
    const now = new Date();
    if (plan) plan.write();
    t.update(dref, approve ? { status: 'approved', reviewedAt: now, reviewedBy: adminUid } : { status: 'rejected', reviewedAt: now, reviewedBy: adminUid, reason: why });
    return { id, status: approve ? 'approved' : 'rejected', coins: plan ? plan.result.coins : null };
  });
}

async function setPaymentInfo(db, body) {
  const upiId = typeof body.upiId === 'string' ? body.upiId.trim() : '';
  if (!UPI_RE.test(upiId)) throw bad('bad_upi', 'Enter a valid UPI ID, for example name@bank.');
  const info = { slot: 'deposit', upiId, updatedAt: new Date() };
  if (body.qrUrl !== undefined && body.qrUrl !== null && body.qrUrl !== '') {
    const qr = typeof body.qrUrl === 'string' ? body.qrUrl.trim() : '';
    if (!qr.startsWith('https://') || qr.length > 500) throw bad('bad_qr', 'QR link must start with https:// (max 500 characters).');
    info.qrUrl = qr;
  }
  await db.collection('paymentInfo').doc('deposit').set(info);
  return { slot: 'deposit', upiId, qrUrl: info.qrUrl || '' };
}

async function deletePaymentInfo(db) { await db.collection('paymentInfo').doc('deposit').delete(); return { ok: true }; }

async function setDepositSettings(db, body) {
  const upd = {};
  if (body.depositOn !== undefined) {
    if (typeof body.depositOn !== 'boolean') throw bad('bad_value', 'depositOn must be true or false.');
    upd.depositOn = body.depositOn;
  }
  if (body.dailyLimit !== undefined) {
    const n = body.dailyLimit;
    if (!Number.isSafeInteger(n) || n < 0 || n > 10000000) throw bad('bad_value', 'dailyLimit must be a whole number from 0 to 10000000.');
    upd.depositDailyLimit = n;
  }
  if (!Object.keys(upd).length) throw bad('bad_value', 'Nothing to change.');
  upd.updatedAt = new Date();
  await db.collection('appInfo').doc('main').set(upd, { merge: true });
  return { ok: true };
}

module.exports = { depositConfig, createDeposit, listMine, adminList, adminProof, review, setPaymentInfo, deletePaymentInfo, setDepositSettings };
