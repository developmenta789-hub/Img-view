'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const { cancelMatch } = require('../src/fscancel');
const { getWallet, applyCoins } = require('../src/fswallet');
const { joinTournament } = require('../src/fsmatches');

const code = (c) => (e) => e.code === c;
const now = () => new Date('2026-10-14T10:00:00Z');
const game = { name: 'P', age18Plus: true, ingameName: 'RahulFF', gameUid: '123456789', gameLevel: 40 };

async function ready(match = {}) {
  const fs = fakeFs();
  fs.store.set('tournaments/m1', { title: 'Night Cup', category: 'br', status: 'upcoming', entryFee: 50, maxPlayers: 4, joined: 0, startTime: new Date(Date.now() + 3600000), ...match });
  for (const u of ['u1', 'u2']) {
    fs.store.set('users/' + u, { ...game, ingameName: 'P' + u });
    await applyCoins(fs, { uid: u, delta: 200, winDelta: u === 'u2' ? 200 : 0, type: 'seed', ref: 's_' + u });
  }
  await joinTournament(fs, { uid: 'u1', name: 'a' }, 'm1', { slot: 1 });
  await joinTournament(fs, { uid: 'u2', name: 'b' }, 'm1', { slot: 2 });
  return fs;
}

test('cancel: status cancelled, every fee back, winnings part back as winnings', async () => {
  const fs = await ready();
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 150, winCoins: 150 });
  const r = await cancelMatch(fs, 'm1', now);
  assert.deepStrictEqual([r.status, r.wasStatus, r.refunded, r.coins, r.alreadyRefunded, r.failed.length], ['cancelled', 'upcoming', 2, 100, 0, 0]);
  assert.strictEqual(fs.store.get('tournaments/m1').status, 'cancelled');
  assert.ok(fs.store.get('tournaments/m1').cancelledAt);
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 200, winCoins: 0 });
  assert.deepStrictEqual(await getWallet(fs, 'u2'), { coins: 200, winCoins: 200 });
  const rf = fs.store.get('refunds/m1_u1');
  assert.deepStrictEqual([rf.uid, rf.amount, rf.tournamentTitle, rf.tournamentId], ['u1', 50, 'Night Cup', 'm1']);
  assert.ok(fs.store.has('wallets/u1/ledger/refund_m1_u1'));
});

test('nobody is refunded twice: second cancel only reports', async () => {
  const fs = await ready();
  await cancelMatch(fs, 'm1', now);
  const again = await cancelMatch(fs, 'm1', now);
  assert.deepStrictEqual([again.refunded, again.coins, again.alreadyRefunded, again.wasStatus], [0, 0, 2, 'cancelled']);
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 200);
});

test('stopped half way: calling cancel again refunds only the rest', async () => {
  const fs = await ready();
  const real = fs.runTransaction.bind(fs); let n = 0;
  fs.runTransaction = (fn) => (++n === 3 ? Promise.reject(new Error('boom')) : real(fn));   // 1 = status, 2 = u1, 3 = u2
  const first = await cancelMatch(fs, 'm1', now);
  assert.deepStrictEqual([first.refunded, first.failed], [1, ['u2']]);
  fs.runTransaction = real;
  const second = await cancelMatch(fs, 'm1', now);
  assert.deepStrictEqual([second.refunded, second.alreadyRefunded, second.failed.length], [1, 1, 0]);
  assert.strictEqual((await getWallet(fs, 'u2')).coins, 200);
});

test('free match: cancelled, nothing to refund. Ongoing match can be cancelled too', async () => {
  const fs = await ready({ entryFee: 0, status: 'upcoming' });
  const r = await cancelMatch(fs, 'm1', now);
  assert.deepStrictEqual([r.refunded, r.coins], [0, 0]);
  const on = await ready();
  on.store.get('tournaments/m1').status = 'ongoing';
  assert.strictEqual((await cancelMatch(on, 'm1', now)).refunded, 2);
});

test('refused: completed match, unknown match, bad id', async () => {
  const fs = await ready();
  fs.store.get('tournaments/m1').status = 'completed';
  await assert.rejects(cancelMatch(fs, 'm1', now), code('completed'));
  await assert.rejects(cancelMatch(fs, 'nope', now), code('not_found'));
  await assert.rejects(cancelMatch(fs, 'a/b', now), code('bad_id'));
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 150);
});

test('after cancel nobody can join any more', async () => {
  const fs = await ready();
  await cancelMatch(fs, 'm1', now);
  fs.store.set('users/u3', { ...game, ingameName: 'Third' });
  await applyCoins(fs, { uid: 'u3', delta: 500, type: 'seed', ref: 's3' });
  await assert.rejects(joinTournament(fs, { uid: 'u3', name: 'c' }, 'm1', { slot: 3 }), code('not_open'));
});

test('HTTP: cancel is admin only', async () => {
  const { start } = require('./helpers');
  const fs = await ready();
  const s = await start({}, fs);
  try {
    assert.strictEqual((await s.call('POST', '/api/v2/admin/tournaments/m1/cancel', { token: 'u1', body: {} })).status, 403);
    const ok = await s.call('POST', '/api/v2/admin/tournaments/m1/cancel', { token: 'owner', body: {} });
    assert.deepStrictEqual([ok.status, ok.json.refunded, ok.json.coins], [200, 2, 100]);
  } finally { await s.stop(); }
});
