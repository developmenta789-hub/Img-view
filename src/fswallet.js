'use strict';
const { HttpError, conflict } = require('./errors');

/**
 * Wallet on Firestore (same documents the apps already read): wallets/{uid} = { coins, winCoins, ... }.
 * Every coin change also writes ONE ledger document wallets/{uid}/ledger/{type_ref}. That id is unique, so the same
 * event (one deposit, one prize, one refund) can never be applied twice. Clients cannot read or write the ledger
 * (no rule matches it, so the final deny-all rule applies). This is the ONLY place coins change on the server.
 *
 * winCoins = the withdrawable winnings part. Spending keeps winCoins unless coins fall below it
 * (same rule as Firestor.rules okWinAfterSpend).
 */
const TYPE_RE = /^[a-z][a-z_]{1,30}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,200}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const isInt = Number.isSafeInteger;

/**
 * Step 1 of a coin change INSIDE an existing Firestore transaction `t`: does all the reads and checks, and returns
 * { result, write() }. Call write() only after every other read of the transaction is done (Firestore: reads first).
 */
async function planCoins(t, db, { uid, delta, winDelta = 0, type, ref, note = '' }) {
  if (!UID_RE.test(String(uid)) || !isInt(delta) || delta === 0 || !isInt(winDelta) || !TYPE_RE.test(String(type)) || !REF_RE.test(String(ref))) {
    throw new HttpError(500, 'bad_coin_call', 'Internal error');
  }
  const wref = db.collection('wallets').doc(uid);
  const lref = wref.collection('ledger').doc(type + '_' + ref);
  const ws = await t.get(wref);
  const ls = await t.get(lref);
  if (ls.exists) throw conflict('already_applied', 'This was already done.');
  const w = ws.exists ? ws.data() : {};
  const oldCoins = isInt(w.coins) ? w.coins : 0;
  const oldWin = isInt(w.winCoins) ? w.winCoins : 0;
  const coins = oldCoins + delta;
  if (coins < 0) throw new HttpError(400, 'not_enough_coins', 'Not enough coins.');
  let win = oldWin + winDelta;
  if (delta < 0 && winDelta === 0) win = Math.min(oldWin, coins);
  if (win < 0 || win > coins) throw new HttpError(500, 'bad_win_coins', 'Internal error');
  const now = new Date();
  return {
    result: { coins, winCoins: win },
    before: { coins: oldCoins, winCoins: oldWin },
    write() {
      t.create(lref, { uid, delta, winDelta, balanceAfter: coins, type, ref: String(ref), note: String(note).slice(0, 200), createdAt: now });
      t.set(wref, { coins, winCoins: win, updatedAt: now }, { merge: true });
    },
  };
}

/**
 * Owner edit INSIDE a transaction: sets coins and winCoins to exact numbers (Admin "Edit wallet"). Same ledger rule as
 * planCoins: ledger doc admin_<ref> (unique), delta + winDelta recorded. winCoins can never be more than coins.
 */
async function planSet(t, db, { uid, coins, winCoins, ref, note = '' }) {
  if (!UID_RE.test(String(uid)) || !REF_RE.test(String(ref)) || !isInt(coins) || coins < 0 || !isInt(winCoins) || winCoins < 0 || winCoins > coins) {
    throw new HttpError(400, 'bad_wallet', 'Coins must be whole numbers and winnings cannot be more than coins.');
  }
  const wref = db.collection('wallets').doc(uid);
  const lref = wref.collection('ledger').doc('admin_' + ref);
  const ws = await t.get(wref);
  const ls = await t.get(lref);
  if (ls.exists) throw conflict('already_applied', 'This was already done.');
  const w = ws.exists ? ws.data() : {};
  const before = { coins: isInt(w.coins) ? w.coins : 0, winCoins: isInt(w.winCoins) ? w.winCoins : 0 };
  const now = new Date();
  return {
    before,
    result: { coins, winCoins },
    write() {
      t.create(lref, { uid, delta: coins - before.coins, winDelta: winCoins - before.winCoins, balanceAfter: coins, type: 'admin', ref: String(ref), note: String(note).slice(0, 200), createdAt: now });
      t.set(wref, { coins, winCoins, updatedAt: now }, { merge: true });
    },
  };
}

/** One coin change in its own transaction. */
function applyCoins(db, args) {
  return db.runTransaction(async (t) => { const p = await planCoins(t, db, args); p.write(); return p.result; });
}

async function getWallet(db, uid) {
  const s = await db.collection('wallets').doc(uid).get();
  const w = s.exists ? s.data() : {};
  return { coins: isInt(w.coins) ? w.coins : 0, winCoins: isInt(w.winCoins) ? w.winCoins : 0 };
}

async function history(db, uid, limit) {
  const n = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 30));
  const q = await db.collection('wallets').doc(uid).collection('ledger').orderBy('createdAt', 'desc').limit(n).get();
  return q.docs.map((d) => {
    const x = d.data();
    return { id: d.id, delta: x.delta, balanceAfter: x.balanceAfter, type: x.type, note: x.note, createdAt: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : +x.createdAt };
  });
}

module.exports = { applyCoins, planCoins, planSet, getWallet, history };
