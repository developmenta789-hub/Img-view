'use strict';
const { HttpError, bad, conflict } = require('./errors');
const { planCoins } = require('./fswallet');

/**
 * Cancel a match and give every player the entry fee back, on Firestore (same documents Admin writes today):
 *   tournaments/{tid}.status = 'cancelled' (+ cancelledAt)   stops new joins (join checks status inside its transaction)
 *   refunds/{tid}_{uid}   { uid, name, tournamentId, tournamentTitle?, amount, createdAt }
 *   wallets/{uid}         fee back as coins; the part that was paid from winnings (registration.winPart) goes back as winnings
 *                         (ledger refund_<tid>_<uid>, unique, so nobody is refunded twice)
 * Entry fees a player paid FOR A FRIEND (paidEntries/{tid}_{friendUid}, fee > 0) go back to the PAYER (refunds/{tid}_{friendUid} with uid = payer).
 * One transaction per player. If something stops half way, call cancel again: it only refunds players not refunded yet.
 * A completed match cannot be cancelled.
 */
const TID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const isInt = Number.isSafeInteger;

async function cancelMatch(db, tid, now = () => new Date()) {
  if (!TID_RE.test(String(tid))) throw bad('bad_id', 'Bad match id.');
  const tref = db.collection('tournaments').doc(tid);
  const info = await db.runTransaction(async (t) => {
    const ts = await t.get(tref);
    if (!ts.exists) throw new HttpError(404, 'not_found', 'Match not found.');
    const m = ts.data();
    if (m.status === 'completed') throw conflict('completed', 'A completed match cannot be cancelled.');
    const was = m.status;
    if (was !== 'cancelled') t.update(tref, { status: 'cancelled', cancelledAt: now() });
    return { title: typeof m.title === 'string' ? m.title.slice(0, 80) : '', was };
  });

  const regs = (await db.collection('registrations').where('tournamentId', '==', tid).get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => isInt(r.fee) && r.fee > 0 && typeof r.uid === 'string' && r.id === tid + '_' + r.uid)
    .map((r) => ({ id: r.id, uid: r.uid, name: r.name, fee: r.fee, winPart: r.winPart }));
  // fee paid for a friend: refunded to the payer (the friend's own registration has fee 0, so it is not in the list above)
  const paidFor = (await db.collection('paidEntries').where('tournamentId', '==', tid).get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => isInt(p.fee) && p.fee > 0 && typeof p.uid === 'string' && typeof p.forUid === 'string' && p.id === tid + '_' + p.forUid)
    .map((p) => ({ id: p.id, uid: p.uid, name: p.forName, fee: p.fee, winPart: p.winPart }));
  regs.push(...paidFor);

  let refunded = 0; let coins = 0; let already = 0; const failed = [];
  for (const r of regs) {
    try {
      await db.runTransaction(async (t) => {
        const fref = db.collection('refunds').doc(r.id);
        const fs = await t.get(fref);
        if (fs.exists) throw conflict('already_refunded', 'x');
        const winPart = isInt(r.winPart) && r.winPart > 0 ? Math.min(r.winPart, r.fee) : 0;
        const plan = await planCoins(t, db, { uid: r.uid, delta: r.fee, winDelta: winPart, type: 'refund', ref: r.id, note: 'Match cancelled: entry fee back' });
        plan.write();
        const rf = { uid: r.uid, name: String(r.name || '').slice(0, 100), tournamentId: tid, amount: r.fee, createdAt: now() };
        if (info.title) rf.tournamentTitle = info.title;
        t.create(fref, rf);
      });
      refunded += 1; coins += r.fee;
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'already_refunded' || e.code === 'already_applied')) { already += 1; continue; }
      failed.push(r.uid);
    }
  }
  return { status: 'cancelled', wasStatus: info.was, refunded, coins, alreadyRefunded: already, failed };
}

module.exports = { cancelMatch };
