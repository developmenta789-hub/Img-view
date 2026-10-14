'use strict';
const crypto = require('node:crypto');
const { HttpError, bad, forbidden } = require('./errors');
const { planSet, getWallet } = require('./fswallet');

/**
 * Owner actions on one player, on Firestore (same fields the Admin app writes today):
 *   users/{uid}.status = active | suspended | banned, statusReason (3..200), suspendedUntil (only while suspended)
 *   users/{uid}.gameVerified (true only when the game profile is complete; the player's own later edit sets it false)
 *   users/{uid}.matchesPlayed / totalKill (Edit activity, 0..1,000,000)
 *   wallets/{uid}  exact coins + winCoins (Edit wallet) + a log walletEdits/{id} + ledger admin_<id>
 * Other admins cannot be banned or suspended here. Every call is one transaction.
 */
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_COINS = 10000000;
const MAX_COUNT = 1000000;
const isInt = Number.isSafeInteger;
const gameDone = (u) => typeof u.ingameName === 'string' && u.ingameName.length >= 2 && typeof u.gameUid === 'string' && /^[0-9]{6,15}$/.test(u.gameUid)
  && Number.isInteger(u.gameLevel) && u.gameLevel >= 1 && u.gameLevel <= 100;

function checkUid(uid) { if (!UID_RE.test(String(uid))) throw bad('bad_uid', 'Bad user id.'); }
async function needUser(t, db, uid) {
  const us = await t.get(db.collection('users').doc(uid));
  if (!us.exists) throw new HttpError(404, 'not_found', 'Player not found.');
  return us.data();
}

async function getUser(db, uid) {
  checkUid(uid);
  const us = await db.collection('users').doc(uid).get();
  if (!us.exists) throw new HttpError(404, 'not_found', 'Player not found.');
  const u = us.data();
  const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : null);
  return { uid, name: u.name || '', email: u.email || '', ingameName: u.ingameName || '', gameUid: u.gameUid || '', gameLevel: u.gameLevel || 0,
    gameVerified: u.gameVerified === true, status: u.status || 'active', statusReason: u.statusReason || '', suspendedUntil: ms(u.suspendedUntil),
    matchesPlayed: u.matchesPlayed || 0, totalKill: u.totalKill || 0, wallet: await getWallet(db, uid) };
}

/** body: { status: 'active'|'suspended'|'banned', hours (suspended: 1..8760), reason (suspended/banned: 3..200) } */
async function setStatus(db, uid, body, now = () => new Date()) {
  checkUid(uid);
  const status = body && body.status;
  if (!['active', 'suspended', 'banned'].includes(status)) throw bad('bad_status', 'Status must be active, suspended or banned.');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  let until = null;
  if (status !== 'active') {
    if (reason.length < 3 || reason.length > 200) throw bad('bad_reason', 'Write a reason of 3 to 200 letters.');
  }
  if (status === 'suspended') {
    if (!isInt(body.hours) || body.hours < 1 || body.hours > 8760) throw bad('bad_hours', 'Use 1 to 8760 hours.');
    until = new Date(now().getTime() + body.hours * 3600000);
  }
  return db.runTransaction(async (t) => {
    const u = await needUser(t, db, uid);
    const as = await t.get(db.collection('admins').doc(uid));
    if (status !== 'active' && as.exists) throw forbidden('is_admin', 'An admin cannot be banned or suspended.');
    const next = { ...u, status };
    delete next.statusReason; delete next.suspendedUntil;
    if (status !== 'active') next.statusReason = reason;
    if (until) next.suspendedUntil = until;
    t.set(db.collection('users').doc(uid), next);
    return { uid, status, suspendedUntil: until ? until.getTime() : null };
  });
}

async function setGameVerified(db, uid, value) {
  checkUid(uid);
  if (typeof value !== 'boolean') throw bad('bad_value', 'value must be true or false.');
  return db.runTransaction(async (t) => {
    const u = await needUser(t, db, uid);
    if (value && !gameDone(u)) throw forbidden('game_details', 'The player has not filled the game details completely.');
    t.update(db.collection('users').doc(uid), { gameVerified: value });
    return { uid, gameVerified: value };
  });
}

async function setActivity(db, uid, body) {
  checkUid(uid);
  const { matchesPlayed: mp, totalKill: tk } = body || {};
  if (!isInt(mp) || !isInt(tk) || mp < 0 || tk < 0 || mp > MAX_COUNT || tk > MAX_COUNT) throw bad('bad_activity', 'Use numbers from 0 to 1,000,000.');
  return db.runTransaction(async (t) => {
    await needUser(t, db, uid);
    t.update(db.collection('users').doc(uid), { matchesPlayed: mp, totalKill: tk });
    return { uid, matchesPlayed: mp, totalKill: tk };
  });
}

/** body: { coins, winCoins, note? }. Sets exact numbers; logs before/after in walletEdits + ledger. */
async function editWallet(db, adminUid, uid, body, now = () => new Date()) {
  checkUid(uid);
  const { coins, winCoins } = body || {};
  const note = typeof (body && body.note) === 'string' ? body.note.trim().slice(0, 200) : '';
  if (!isInt(coins) || !isInt(winCoins) || coins < 0 || winCoins < 0 || coins > MAX_COINS) throw bad('bad_wallet', 'Coins must be whole numbers from 0 to ' + MAX_COINS + '.');
  if (winCoins > coins) throw bad('bad_wallet', 'Winnings cannot be more than coins.');
  const id = crypto.randomBytes(10).toString('hex');
  return db.runTransaction(async (t) => {
    await needUser(t, db, uid);
    const plan = await planSet(t, db, { uid, coins, winCoins, ref: id, note: note || 'Edited by owner' });
    plan.write();
    t.create(db.collection('walletEdits').doc(id), { uid, by: adminUid, coinsBefore: plan.before.coins, coinsAfter: coins, winBefore: plan.before.winCoins, winAfter: winCoins, note, createdAt: now() });
    return { uid, coins, winCoins, before: plan.before, editId: id };
  });
}

module.exports = { getUser, setStatus, setGameVerified, setActivity, editWallet };
