'use strict';
const { conflict, HttpError } = require('./errors');

/**
 * The ONLY place where coins change. Call it inside tx().
 * delta > 0 adds coins, delta < 0 removes them (never below 0). winDelta moves the "winnings" part (prizes) the same way.
 * (type, ref) is unique in the ledger, so the same event (for example one deposit) can never be applied twice.
 */
function applyCoins(db, { uid, delta, winDelta = 0, type, ref, note = '' }) {
  if (!Number.isSafeInteger(delta) || delta === 0) throw new HttpError(500, 'bad_delta', 'Internal error');
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO wallets (uid, coins, win_coins, updated_at) VALUES (?, 0, 0, ?)').run(uid, now);
  const w = db.prepare('SELECT coins, win_coins FROM wallets WHERE uid = ?').get(uid);
  const coins = w.coins + delta;
  const win = w.win_coins + winDelta;
  if (coins < 0) throw new HttpError(400, 'not_enough_coins', 'Not enough coins.');
  if (win < 0 || win > coins) throw new HttpError(500, 'bad_win_coins', 'Internal error');
  try {
    db.prepare('INSERT INTO ledger (uid, delta, balance_after, type, ref, note, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(uid, delta, coins, type, String(ref), note, now);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw conflict('already_applied', 'This was already done.');
    throw e;
  }
  db.prepare('UPDATE wallets SET coins = ?, win_coins = ?, updated_at = ? WHERE uid = ?').run(coins, win, now, uid);
  return coins;
}

function getWallet(db, uid) {
  const w = db.prepare('SELECT coins, win_coins FROM wallets WHERE uid = ?').get(uid);
  return { coins: w ? w.coins : 0, winCoins: w ? w.win_coins : 0 };
}

function history(db, uid, limit) {
  const n = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  return db.prepare('SELECT id, delta, balance_after AS balanceAfter, type, note, created_at AS createdAt FROM ledger WHERE uid = ? ORDER BY id DESC LIMIT ?').all(uid, n);
}

module.exports = { applyCoins, getWallet, history };
