'use strict';
const { HttpError, bad, forbidden, conflict } = require('./errors');
const { planCoins } = require('./fswallet');

/**
 * Joining a match on Firestore. One transaction does everything the Arena batch + Firestor.rules did:
 *   registrations/{tid}_{uid}   { tournamentId, uid, name, fee, slot, createdAt, winPart? }
 *   tournaments/{tid}/slots/{n} { uid, name, createdAt }
 *   tournaments/{tid}.joined + 1
 *   wallets/{uid}               fee taken (deposit coins first, winnings last; ledger join_fee_<tid>_<uid>)
 *   slotInvites/{tid}_{n}       a reserved seat only its invited player can take (for 5 minutes from createdAt); the invite is used up here
 *   paidEntries/{tid}_{friendUid} (only when the invite has pay:true) the inviter pays the friend's entry fee at the friend's join:
 *                               { uid: payer, forUid, forName, tournamentId, tournamentTitle?, fee, winPart?, createdAt }. The friend's registration then has fee 0 + paidBy + paidFee.
 * The fee is read from the match itself (never from the app). Free matches (entryFee 0) do not touch the wallet.
 */
const TID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const INVITE_TTL_MS = 5 * 60 * 1000;   // SAME number as duration.value(5, 'm') in Firestor.rules (siExpired) and INVITE.ttlMin in Arena js/config.js
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || 0);
const inviteExpired = (i) => { const c = ms(i.createdAt); return c > 0 && c + INVITE_TTL_MS <= Date.now(); };   // the invite timer starts at createdAt (server time)
const gameDone = (u) => typeof u.ingameName === 'string' && u.ingameName.length >= 2 && typeof u.gameUid === 'string' && /^[0-9]{6,15}$/.test(u.gameUid)
  && Number.isInteger(u.gameLevel) && u.gameLevel >= 1 && u.gameLevel <= 100;
const blocked = (u) => { const st = u.status || 'active'; return st === 'banned' || (st === 'suspended' && (!u.suspendedUntil || ms(u.suspendedUntil) > Date.now())); };

async function joinTournament(db, user, tid, body) {
  if (!TID_RE.test(String(tid))) throw bad('bad_id', 'Bad match id.');
  const slot = body && body.slot;
  if (!Number.isSafeInteger(slot) || slot < 1) throw bad('bad_slot', 'Pick a slot.');
  const tref = db.collection('tournaments').doc(tid);
  const rref = db.collection('registrations').doc(tid + '_' + user.uid);
  const sref = tref.collection('slots').doc(String(slot));
  const iref = db.collection('slotInvites').doc(tid + '_' + slot);
  return db.runTransaction(async (t) => {
    const ts = await t.get(tref);
    const rs = await t.get(rref);
    const ss = await t.get(sref);
    const is = await t.get(iref);
    const us = await t.get(db.collection('users').doc(user.uid));
    const info = await t.get(db.collection('appInfo').doc('main'));
    if (!ts.exists) throw new HttpError(404, 'not_found', 'Match not found.');
    const m = ts.data();
    const u = us.exists ? us.data() : {};
    if (m.status !== 'upcoming') throw forbidden('not_open', 'This match is not open for joining.');
    if (!(Date.now() < ms(m.startTime))) throw forbidden('closed', 'Joining has closed for this match.');
    if (m.joinEnabled === false) throw forbidden('join_off', 'Joining is switched off for this match.');
    if (!us.exists || !gameDone(u)) throw forbidden('game_details', 'Add your game details first.');
    if (blocked(u)) throw forbidden('blocked', 'This account cannot join matches right now.');
    const minLevel = info.exists && Number.isInteger(info.data().minGameLevel) ? info.data().minGameLevel : 0;
    if (u.gameLevel < minLevel) throw forbidden('level_too_low', `You need game level ${minLevel} to join matches.`);
    if (rs.exists) throw conflict('already_joined', 'You already joined this match.');
    const joined = Number.isInteger(m.joined) ? m.joined : 0;
    if (!(Number.isSafeInteger(m.maxPlayers) && m.maxPlayers > 0) || joined >= m.maxPlayers) throw conflict('full', 'This match is full.');
    if (slot > m.maxPlayers) throw bad('bad_slot', 'That slot does not exist.');
    if (ss.exists) throw conflict('slot_taken', 'Someone just took this slot. Pick another one.');
    // Invite timer (2026-10-16): an invite lives INVITE_TTL_MS (createdAt + TTL). After that it reserves nothing: anyone may take the seat.
    const invRaw = is.exists ? is.data() : null;
    const invLive = !!invRaw && !inviteExpired(invRaw);
    if (invLive && invRaw.toUid !== user.uid) throw conflict('slot_reserved', 'This slot is reserved for an invited player.');
    const fee = Number.isSafeInteger(m.entryFee) && m.entryFee > 0 ? m.entryFee : 0;
    const name = u.ingameName.slice(0, 100);
    // Paid invite (inviter chose "I pay my friend's entry fee"): the fee comes from the INVITER's wallet, not from this player.
    // The inviter made the invite themself (rules: fromUid == their uid), so they can only ever spend their own coins.
    // An EXPIRED paid invite is refused (not silently turned into "you pay yourself"): the friend was told "fee paid", so the app must refresh and ask again.
    if (invRaw && !invLive && invRaw.toUid === user.uid && invRaw.pay === true && fee > 0) throw conflict('invite_expired', 'This invite has expired. Ask your friend to send it again, or pick a slot and pay the entry fee yourself.');
    const inv = invLive ? invRaw : null;
    const paid = !!(inv && inv.toUid === user.uid && inv.pay === true && fee > 0 && typeof inv.fromUid === 'string');
    if (paid) {
      const ps = await t.get(db.collection('registrations').doc(tid + '_' + inv.fromUid));
      const pu = await t.get(db.collection('users').doc(inv.fromUid));
      if (!ps.exists) throw conflict('payer_left', 'The friend who invited you is no longer in this match.');
      if (!pu.exists || blocked(pu.data())) throw forbidden('payer_blocked', 'Your friend cannot pay your entry fee right now.');
    }
    let plan = null;
    if (fee > 0) {
      try {
        plan = await planCoins(t, db, { uid: paid ? inv.fromUid : user.uid, delta: -fee, type: 'join_fee', ref: tid + '_' + user.uid, note: paid ? 'Entry fee paid for ' + name : 'Match entry fee' });
      } catch (e) {
        if (paid && e instanceof HttpError && e.code === 'not_enough_coins') throw new HttpError(400, 'payer_no_coins', 'Your friend does not have enough coins to pay your entry fee right now.');
        throw e;
      }
    }
    const now = new Date();
    const reg = { tournamentId: tid, uid: user.uid, name, fee: paid ? 0 : fee, slot, createdAt: now };
    let winPart = 0;
    if (plan) { plan.write(); winPart = plan.before.winCoins - plan.result.winCoins; }
    if (paid) {
      reg.paidBy = inv.fromUid; reg.paidFee = fee;
      const pe = { uid: inv.fromUid, forUid: user.uid, forName: name, tournamentId: tid, fee, createdAt: now };
      if (typeof m.title === 'string' && m.title) pe.tournamentTitle = m.title.slice(0, 80);
      if (winPart > 0) pe.winPart = winPart;
      t.create(db.collection('paidEntries').doc(tid + '_' + user.uid), pe);
    } else if (winPart > 0) reg.winPart = winPart;
    t.create(rref, reg);
    t.create(sref, { uid: user.uid, name, createdAt: now });
    t.update(tref, { joined: joined + 1 });
    if (is.exists) t.delete(iref);
    return { tournamentId: tid, slot, fee, paidBy: paid ? inv.fromUid : null, joined: joined + 1, coins: plan && !paid ? plan.result.coins : null, winCoins: plan && !paid ? plan.result.winCoins : null };
  });
}

module.exports = { joinTournament, inviteExpired, INVITE_TTL_MS };
