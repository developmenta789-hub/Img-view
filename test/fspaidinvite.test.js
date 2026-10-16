'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const { joinTournament } = require('../src/fsmatches');
const { cancelMatch } = require('../src/fscancel');
const { getWallet, applyCoins } = require('../src/fswallet');

// u2 = the payer (already in the match, slot 1). u1 = the friend with NO coins, invited into slot 2 with pay:true.
const game = { name: 'P', age18Plus: true, ingameName: 'Friend', gameUid: '123456789', gameLevel: 40 };
const code = (c) => (e) => e.code === c;
const friend = { uid: 'u1', name: 'f' };
const payer = { uid: 'u2', name: 'p' };

async function ready({ payerCoins = 200, payerWin = 0, invite = {}, payerJoined = true } = {}) {
  const fs = fakeFs();
  fs.store.set('tournaments/m1', { title: 'Night Cup', category: 'br', status: 'upcoming', entryFee: 50, maxPlayers: 4, teamSize: 2, joined: 0, startTime: new Date(Date.now() + 3600000) });
  fs.store.set('users/u1', { ...game });
  fs.store.set('users/u2', { ...game, ingameName: 'Payer' });
  if (payerCoins) await applyCoins(fs, { uid: 'u2', delta: payerCoins, winDelta: payerWin, type: 'seed', ref: 's2' });
  if (payerJoined) await joinTournament(fs, payer, 'm1', { slot: 1 });
  fs.store.set('slotInvites/m1_2', { tournamentId: 'm1', slot: 2, fromUid: 'u2', fromName: 'Payer', toUid: 'u1', toName: 'Friend', pay: true, ...invite });
  return fs;
}

test('paid invite: friend joins with 0 coins, the fee is taken from the inviter, friend wallet untouched', async () => {
  const fs = await ready();
  const r = await joinTournament(fs, friend, 'm1', { slot: 2 });
  assert.deepStrictEqual([r.slot, r.fee, r.paidBy, r.coins, r.joined], [2, 50, 'u2', null, 2]);
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 100, winCoins: 0 });   // 200 - own fee 50 - friend fee 50
  assert.ok(!fs.store.has('wallets/u1'));
  const reg = fs.store.get('registrations/m1_u1');
  assert.deepStrictEqual([reg.uid, reg.fee, reg.paidBy, reg.paidFee, reg.slot], ['u1', 0, 'u2', 50, 2]);
  const pe = fs.store.get('paidEntries/m1_u1');
  assert.deepStrictEqual([pe.uid, pe.forUid, pe.forName, pe.fee, pe.tournamentTitle], ['u2', 'u1', 'Friend', 50, 'Night Cup']);
  assert.ok(fs.store.has('wallets/u2/ledger/join_fee_m1_u1'));
  assert.ok(!fs.store.has('slotInvites/m1_2'));
  assert.strictEqual(fs.store.get('tournaments/m1/slots/2').uid, 'u1');
});

test('paid invite: winnings of the inviter are spent last and remembered as winPart', async () => {
  const fs = await ready({ payerCoins: 100, payerWin: 80 });   // 20 deposit + 80 winnings; own fee takes 50 (winPart 30), friend fee takes 50 more
  await joinTournament(fs, friend, 'm1', { slot: 2 });
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 0, winCoins: 0 });
  assert.strictEqual(fs.store.get('registrations/m1_u2').winPart, 30);
  assert.strictEqual(fs.store.get('paidEntries/m1_u1').winPart, 50);
});

test('paid invite: inviter has too few coins, friend gets a clear error and nothing is written', async () => {
  const fs = await ready({ payerCoins: 50 });   // own fee takes all 50
  await assert.rejects(joinTournament(fs, friend, 'm1', { slot: 2 }), code('payer_no_coins'));
  assert.ok(!fs.store.has('registrations/m1_u1')); assert.ok(!fs.store.has('paidEntries/m1_u1'));
  assert.ok(fs.store.has('slotInvites/m1_2'));
  assert.strictEqual(fs.store.get('tournaments/m1').joined, 1);
});

test('paid invite: inviter not in the match, or banned: refused', async () => {
  const fs = await ready({ payerJoined: false });
  await assert.rejects(joinTournament(fs, friend, 'm1', { slot: 2 }), code('payer_left'));
  const fs2 = await ready();
  fs2.store.set('users/u2', { ...game, ingameName: 'Payer', status: 'banned' });   // banned AFTER joining
  await assert.rejects(joinTournament(fs2, friend, 'm1', { slot: 2 }), code('payer_blocked'));
});

test('normal invite (no pay flag): the friend pays his own fee, so 0 coins is refused', async () => {
  const fs = await ready({ invite: { pay: undefined } });
  await assert.rejects(joinTournament(fs, friend, 'm1', { slot: 2 }), code('not_enough_coins'));
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 150, winCoins: 0 });
});

test('pay flag only counts for the invited friend: another player cannot use the reserved slot', async () => {
  const fs = await ready();
  fs.store.set('users/u3', { ...game, ingameName: 'Third' });
  await assert.rejects(joinTournament(fs, { uid: 'u3', name: 't' }, 'm1', { slot: 2 }), code('slot_reserved'));
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 150, winCoins: 0 });
});

test('cancel: the fee paid for the friend goes back to the PAYER, once', async () => {
  const fs = await ready({ payerCoins: 100, payerWin: 80 });
  await joinTournament(fs, friend, 'm1', { slot: 2 });
  const r = await cancelMatch(fs, 'm1', () => new Date('2026-10-14T10:00:00Z'));
  assert.deepStrictEqual([r.refunded, r.coins, r.failed.length], [2, 100, 0]);
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 100, winCoins: 80 });   // all of it back, winnings back as winnings
  assert.ok(!fs.store.has('wallets/u1'));
  const rf = fs.store.get('refunds/m1_u1');
  assert.deepStrictEqual([rf.uid, rf.amount, rf.name], ['u2', 50, 'Friend']);
  const again = await cancelMatch(fs, 'm1', () => new Date('2026-10-14T10:05:00Z'));
  assert.deepStrictEqual([again.refunded, again.alreadyRefunded], [0, 2]);
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 100, winCoins: 80 });
});

// ---- invite timer (2026-10-16): an invite lives 5 minutes ----
const ago = (min) => new Date(Date.now() - min * 60000);
test('invite timer: expired invite frees the seat for anyone', async () => {
  const fs = await ready({ invite: { pay: undefined, createdAt: ago(6) } });
  fs.store.set('users/u3', { ...game, ingameName: 'Third' });
  await applyCoins(fs, { uid: 'u3', delta: 80, type: 'seed', ref: 's3' });
  const r = await joinTournament(fs, { uid: 'u3', name: 'x' }, 'm1', { slot: 2 });
  assert.strictEqual(r.slot, 2);
  assert.ok(!fs.store.has('slotInvites/m1_2'));
});
test('invite timer: a live invite for someone else is refused with slot_reserved', async () => {
  const fs = await ready({ invite: { pay: undefined, createdAt: ago(2) } });
  fs.store.set('users/u3', { ...game, ingameName: 'Third' });
  await assert.rejects(joinTournament(fs, { uid: 'u3', name: 'x' }, 'm1', { slot: 2 }), code('slot_reserved'));
});
test('invite timer: expired PAID invite is refused (friend must not be charged by surprise); nothing written', async () => {
  const fs = await ready({ invite: { createdAt: ago(5.5) } });
  await assert.rejects(joinTournament(fs, friend, 'm1', { slot: 2 }), code('invite_expired'));
  assert.ok(!fs.store.has('registrations/m1_u1'));
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 150, winCoins: 0 });
});
test('invite timer: expired FREE invite for the friend: friend can still join that seat and pays own fee', async () => {
  const fs = await ready({ invite: { pay: undefined, createdAt: ago(5.5) } });
  await applyCoins(fs, { uid: 'u1', delta: 80, type: 'seed', ref: 's1' });
  const r = await joinTournament(fs, friend, 'm1', { slot: 2 });
  assert.deepStrictEqual([r.slot, r.fee, r.paidBy], [2, 50, null]);
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 30, winCoins: 0 });
});
test('invite timer: timer = createdAt + 5 minutes (old invites too)', async () => {
  const fs = await ready({ invite: { pay: undefined, createdAt: ago(6) } });
  fs.store.set('users/u3', { ...game, ingameName: 'Third' });
  await applyCoins(fs, { uid: 'u3', delta: 80, type: 'seed', ref: 's3' });
  assert.strictEqual((await joinTournament(fs, { uid: 'u3', name: 'x' }, 'm1', { slot: 2 })).slot, 2);
});
