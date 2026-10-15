'use strict';
const crypto = require('node:crypto');
const { HttpError, bad, forbidden, conflict } = require('./errors');
const { planCoins } = require('./fswallet');
const { decodeJpeg } = require('./deposits');

/**
 * Withdrawals on Firestore (same documents as the apps):
 *   withdrawals/{id}       { uid, name, amount, payout, status, createdAt, reviewedAt?, reviewedBy?, reason? }
 *   withdrawalProofs/{id}  { uid, img, createdAt }   (owner's payment screenshot, base64 JPEG)
 *   appInfo/main           withdrawOn?, withdrawMin?  (only these two are touched here)
 * Only WINNINGS (wallets.winCoins) can be withdrawn. Request = coins held at once (ledger withdraw_hold_<id>).
 * Reject = coins come back (withdraw_refund_<id>, winnings too). Paid (approve) needs the player's game account
 * verified AND a payment screenshot. Every step is one transaction.
 */
const PAYOUT_RE = /^([A-Za-z0-9._-]{2,60}@[A-Za-z0-9]{2,30}|[6-9][0-9]{9})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || 0);
const mine = (db, uid) => db.collection('withdrawals').where('uid', '==', uid);
const gameDone = (u) => typeof u.ingameName === 'string' && u.ingameName.length >= 2 && typeof u.gameUid === 'string' && /^[0-9]{6,15}$/.test(u.gameUid)
  && Number.isInteger(u.gameLevel) && u.gameLevel >= 1 && u.gameLevel <= 100;
const blocked = (u) => { const st = u.status || 'active'; return st === 'banned' || (st === 'suspended' && (!u.suspendedUntil || ms(u.suspendedUntil) > Date.now())); };

async function settings(t, db) {
  const a = await t.get(db.collection('appInfo').doc('main'));
  const x = a.exists ? a.data() : {};
  return { on: x.withdrawOn !== false, min: Number.isSafeInteger(x.withdrawMin) && x.withdrawMin >= 0 ? Math.max(1, x.withdrawMin) : 1 };
}

async function withdrawConfig(db, uid) {
  return db.runTransaction(async (t) => {
    const s = await settings(t, db);
    const w = uid ? await t.get(db.collection('wallets').doc(uid)) : { exists: false };
    const win = w.exists && Number.isSafeInteger(w.data().winCoins) ? w.data().winCoins : 0;
    return { withdrawOn: s.on, min: s.min, winCoins: win };
  });
}

async function createWithdrawal(db, cfg, user, body) {
  const amount = typeof body.amount === 'string' && /^[0-9]{1,8}$/.test(body.amount) ? Number(body.amount) : body.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw bad('bad_amount', 'Enter a whole amount.');
  const payout = typeof body.payout === 'string' ? body.payout.trim() : '';
  if (!PAYOUT_RE.test(payout)) throw bad('bad_payout', 'Enter a valid UPI ID or a 10 digit mobile number.');
  const id = crypto.randomBytes(15).toString('base64url');
  const dref = db.collection('withdrawals').doc(id);
  return db.runTransaction(async (t) => {
    const us = await t.get(db.collection('users').doc(user.uid));
    const s = await settings(t, db);
    const pend = (await t.get(mine(db, user.uid))).docs.filter((d) => d.data().status === 'pending').length;
    const plan = await planCoins(t, db, { uid: user.uid, delta: -amount, winDelta: -amount, type: 'withdraw_hold', ref: id, note: 'Withdraw requested' }).catch((e) => {
      if (e.code === 'not_enough_coins' || e.code === 'bad_win_coins') throw bad('not_enough_winnings', 'You can withdraw only your winnings.');
      throw e;
    });
    if (!us.exists || !gameDone(us.data())) throw forbidden('game_details', 'Add your game details first.');
    if (blocked(us.data())) throw forbidden('blocked', 'This account cannot withdraw right now.');
    if (!s.on) throw forbidden('withdraw_off', 'Withdrawals are currently closed. Please try again later.');
    if (amount < s.min) throw bad('below_min', `Minimum withdraw is ${s.min}.`);
    if (pend >= cfg.withdrawMaxPending) throw new HttpError(429, 'too_many_pending', 'You already have pending withdrawals. Wait until they are checked.');
    plan.write();
    const now = new Date();
    t.create(dref, { uid: user.uid, name: String(us.data().name || user.name || 'Player').trim().slice(0, 100) || 'Player', amount, payout, status: 'pending', createdAt: now });
    return { id, status: 'pending', amount, coins: plan.result.coins, winCoins: plan.result.winCoins, createdAt: now.getTime() };
  });
}

const out = (x) => ({ id: x.id, uid: x.uid, name: x.name, amount: x.amount, payout: x.payout, status: x.status, reason: x.reason || '', createdAt: ms(x.createdAt), reviewedAt: x.reviewedAt ? ms(x.reviewedAt) : null });

async function listMine(db, uid, limit) {
  const n = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 30));
  const q = await mine(db, uid).get();
  return q.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt)).slice(0, n).map(out);
}

async function adminList(db, status, limit) {
  const n = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 100));
  const col = db.collection('withdrawals');
  const q = ['pending', 'approved', 'rejected'].includes(status) ? col.where('status', '==', status).limit(n) : col.orderBy('createdAt', 'desc').limit(n);
  const rows = (await q.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || ms(b.createdAt) - ms(a.createdAt));
  return rows.map(out);
}

/** The owner's payment screenshot. Admin may read any; a player only their own. */
async function proof(db, id, uid, admin) {
  if (!ID_RE.test(id)) throw bad('bad_id', 'Bad request id.');
  const s = await db.collection('withdrawalProofs').doc(id).get();
  if (!s.exists || (!admin && s.data().uid !== uid)) throw new HttpError(404, 'not_found', 'Screenshot not found.');
  return { img: s.data().img };
}

async function review(db, cfg, adminUid, id, approve, body = {}) {
  if (!ID_RE.test(id)) throw bad('bad_id', 'Bad request id.');
  let why = ''; let img = '';
  if (approve) {
    decodeJpeg(body.img, cfg.maxImgBytes, 'payment screenshot');
    img = body.img;
  } else {
    why = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (why.length < 3 || why.length > 120) throw bad('bad_reason', 'Write a reason of 3 to 120 characters.');
  }
  const dref = db.collection('withdrawals').doc(id);
  return db.runTransaction(async (t) => {
    const ds = await t.get(dref);
    if (!ds.exists) throw new HttpError(404, 'not_found', 'Withdrawal not found.');
    const d = ds.data();
    if (d.status !== 'pending') throw conflict('not_pending', 'This request was already ' + d.status + '.');
    const us = await t.get(db.collection('users').doc(d.uid));
    if (approve && !(us.exists && us.data().gameVerified === true && gameDone(us.data()))) throw forbidden('not_verified', 'Verify the player\'s game account first.');
    const plan = approve ? null : await planCoins(t, db, { uid: d.uid, delta: d.amount, winDelta: d.amount, type: 'withdraw_refund', ref: id, note: 'Withdraw rejected' });
    const now = new Date();
    if (plan) plan.write();
    if (approve) {
      t.create(db.collection('withdrawalProofs').doc(id), { uid: d.uid, img, createdAt: now });
      t.update(dref, { status: 'approved', reviewedAt: now, reviewedBy: adminUid });
    } else {
      t.update(dref, { status: 'rejected', reviewedAt: now, reviewedBy: adminUid, reason: why });
    }
    return { id, status: approve ? 'approved' : 'rejected' };
  });
}

async function setWithdrawSettings(db, body) {
  const upd = {};
  if (body.withdrawOn !== undefined) {
    if (typeof body.withdrawOn !== 'boolean') throw bad('bad_value', 'withdrawOn must be true or false.');
    upd.withdrawOn = body.withdrawOn;
  }
  if (body.withdrawMin !== undefined) {
    const n = body.withdrawMin;
    if (!Number.isSafeInteger(n) || n < 0 || n > 10000000) throw bad('bad_value', 'withdrawMin must be a whole number from 0 to 10000000.');
    upd.withdrawMin = n;
  }
  if (!Object.keys(upd).length) throw bad('bad_value', 'Nothing to change.');
  upd.updatedAt = new Date();
  await db.collection('appInfo').doc('main').set(upd, { merge: true });
  return { ok: true };
}

module.exports = { withdrawConfig, createWithdrawal, listMine, adminList, proof, review, setWithdrawSettings };
