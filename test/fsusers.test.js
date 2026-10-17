'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const fsu = require('../src/fsusers');
const { getWallet, applyCoins } = require('../src/fswallet');
const { joinTournament } = require('../src/fsmatches');

const code = (c) => (e) => e.code === c;
const T0 = new Date();   // was a fixed 2026-10-14 date: the 24 h suspension in the test had already ended in real time (2026-10-16 onwards)
const now = () => T0;
const game = { name: 'Rahul', email: 'r@x.com', ingameName: 'RahulFF', gameUid: '123456789', gameLevel: 40 };

async function ready() {
  const fs = fakeFs();
  fs.store.set('users/u1', { ...game });
  fs.store.set('users/u2', { ...game, gameUid: '' });
  fs.store.set('admins/boss', {}); fs.store.set('users/boss', { ...game });
  await applyCoins(fs, { uid: 'u1', delta: 100, winDelta: 40, type: 'seed', ref: 's1' });
  return fs;
}

test('suspend: status, reason, end time; join is refused while suspended, allowed after it ends', async () => {
  const fs = await ready();
  const r = await fsu.setStatus(fs, 'u1', { status: 'suspended', hours: 24, reason: ' cheating ' }, now);
  assert.deepStrictEqual([r.status, r.suspendedUntil], ['suspended', T0.getTime() + 86400000]);
  const u = fs.store.get('users/u1');
  assert.deepStrictEqual([u.status, u.statusReason, u.ingameName], ['suspended', 'cheating', 'RahulFF']);
  fs.store.set('tournaments/m1', { status: 'upcoming', entryFee: 0, maxPlayers: 4, joined: 0, startTime: new Date(Date.now() + 3600000) });
  await assert.rejects(joinTournament(fs, { uid: 'u1', name: 'a' }, 'm1', { slot: 1 }), code('blocked'));
  fs.store.get('users/u1').suspendedUntil = new Date(Date.now() - 1000);
  assert.strictEqual((await joinTournament(fs, { uid: 'u1', name: 'a' }, 'm1', { slot: 1 })).joined, 1);
});

test('ban removes the end time; active removes reason and end time', async () => {
  const fs = await ready();
  await fsu.setStatus(fs, 'u1', { status: 'suspended', hours: 5, reason: 'abc' }, now);
  await fsu.setStatus(fs, 'u1', { status: 'banned', reason: 'fake account' }, now);
  let u = fs.store.get('users/u1');
  assert.deepStrictEqual([u.status, u.statusReason, 'suspendedUntil' in u], ['banned', 'fake account', false]);
  await fsu.setStatus(fs, 'u1', { status: 'active' }, now);
  u = fs.store.get('users/u1');
  assert.deepStrictEqual([u.status, 'statusReason' in u, 'suspendedUntil' in u, u.gameUid], ['active', false, false, '123456789']);
});

test('status refused: bad status, short reason, bad hours, unknown user, admin, bad uid', async () => {
  const fs = await ready();
  await assert.rejects(fsu.setStatus(fs, 'u1', { status: 'x' }, now), code('bad_status'));
  await assert.rejects(fsu.setStatus(fs, 'u1', { status: 'banned', reason: 'ab' }, now), code('bad_reason'));
  await assert.rejects(fsu.setStatus(fs, 'u1', { status: 'banned', reason: 'x'.repeat(201) }, now), code('bad_reason'));
  await assert.rejects(fsu.setStatus(fs, 'u1', { status: 'suspended', hours: 0, reason: 'abc' }, now), code('bad_hours'));
  await assert.rejects(fsu.setStatus(fs, 'u1', { status: 'suspended', hours: 8761, reason: 'abc' }, now), code('bad_hours'));
  await assert.rejects(fsu.setStatus(fs, 'nope', { status: 'banned', reason: 'abc' }, now), code('not_found'));
  await assert.rejects(fsu.setStatus(fs, 'boss', { status: 'banned', reason: 'abc' }, now), code('is_admin'));
  await assert.rejects(fsu.setStatus(fs, 'a/b', { status: 'active' }, now), code('bad_uid'));
  assert.strictEqual(fs.store.get('users/u1').status, undefined);
});

test('game verify: only with complete game details; false always works', async () => {
  const fs = await ready();
  assert.strictEqual((await fsu.setGameVerified(fs, 'u1', true)).gameVerified, true);
  assert.strictEqual(fs.store.get('users/u1').gameVerified, true);
  await assert.rejects(fsu.setGameVerified(fs, 'u2', true), code('game_details'));
  await fsu.setGameVerified(fs, 'u2', false);
  await assert.rejects(fsu.setGameVerified(fs, 'u1', 'yes'), code('bad_value'));
  await assert.rejects(fsu.setGameVerified(fs, 'nope', true), code('not_found'));
});

test('activity edit: whole numbers 0..1,000,000', async () => {
  const fs = await ready();
  await fsu.setActivity(fs, 'u1', { matchesPlayed: 12, totalKill: 40 });
  assert.deepStrictEqual([fs.store.get('users/u1').matchesPlayed, fs.store.get('users/u1').totalKill], [12, 40]);
  await assert.rejects(fsu.setActivity(fs, 'u1', { matchesPlayed: -1, totalKill: 0 }), code('bad_activity'));
  await assert.rejects(fsu.setActivity(fs, 'u1', { matchesPlayed: 1, totalKill: 1000001 }), code('bad_activity'));
  await assert.rejects(fsu.setActivity(fs, 'u1', { matchesPlayed: 1.5, totalKill: 1 }), code('bad_activity'));
});

test('wallet edit: exact numbers, before/after log, ledger with delta', async () => {
  const fs = await ready();
  const r = await fsu.editWallet(fs, 'boss', 'u1', { coins: 250, winCoins: 100, note: 'bonus' }, now);
  assert.deepStrictEqual([r.coins, r.winCoins, r.before], [250, 100, { coins: 100, winCoins: 40 }]);
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 250, winCoins: 100 });
  const log = fs.store.get('walletEdits/' + r.editId);
  assert.deepStrictEqual([log.uid, log.by, log.coinsBefore, log.coinsAfter, log.winBefore, log.winAfter, log.note], ['u1', 'boss', 100, 250, 40, 100, 'bonus']);
  const led = fs.store.get('wallets/u1/ledger/admin_' + r.editId);
  assert.deepStrictEqual([led.delta, led.winDelta, led.balanceAfter, led.type], [150, 60, 250, 'admin']);
  const down = await fsu.editWallet(fs, 'boss', 'u1', { coins: 0, winCoins: 0 }, now);
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 0, winCoins: 0 });
  assert.strictEqual(fs.store.get('wallets/u1/ledger/admin_' + down.editId).delta, -250);
});

test('wallet edit refused: winnings > coins, negative, decimals, too big, unknown user; nothing written', async () => {
  const fs = await ready();
  for (const b of [{ coins: 10, winCoins: 11 }, { coins: -1, winCoins: 0 }, { coins: 1.5, winCoins: 0 }, { coins: 10000001, winCoins: 0 }, { coins: '5', winCoins: 0 }]) {
    await assert.rejects(fsu.editWallet(fs, 'boss', 'u1', b, now), code('bad_wallet'));
  }
  await assert.rejects(fsu.editWallet(fs, 'boss', 'nope', { coins: 1, winCoins: 0 }, now), code('not_found'));
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 100, winCoins: 40 });
  assert.ok(![...fs.store.keys()].some((k) => k.startsWith('walletEdits/')));
});

test('get user shows profile, status and wallet', async () => {
  const fs = await ready();
  const u = await fsu.getUser(fs, 'u1');
  assert.deepStrictEqual([u.ingameName, u.status, u.gameVerified, u.wallet], ['RahulFF', 'active', false, { coins: 100, winCoins: 40 }]);
  await assert.rejects(fsu.getUser(fs, 'nope'), code('not_found'));
});

test('HTTP: all user routes are admin only and work for the owner', async () => {
  const { start } = require('./helpers');
  const fs = await ready();
  const s = await start({}, fs);
  try {
    for (const [method, path, body] of [['GET', '/api/v2/admin/users/u1'], ['POST', '/api/v2/admin/users/u1/status', { status: 'active' }],
      ['POST', '/api/v2/admin/users/u1/game-verified', { value: true }], ['POST', '/api/v2/admin/users/u1/activity', { matchesPlayed: 1, totalKill: 1 }],
      ['POST', '/api/v2/admin/users/u1/wallet', { coins: 1, winCoins: 0 }]]) {
      assert.strictEqual((await s.call(method, path, { body })).status, 401, path);
      assert.strictEqual((await s.call(method, path, { token: 'u1', body })).status, 403, path);
    }
    const ok = await s.call('POST', '/api/v2/admin/users/u1/status', { token: 'owner', body: { status: 'banned', reason: 'cheating' } });
    assert.deepStrictEqual([ok.status, ok.json.status], [200, 'banned']);
    const w = await s.call('POST', '/api/v2/admin/users/u1/wallet', { token: 'owner', body: { coins: 500, winCoins: 20, note: 'fix' } });
    assert.deepStrictEqual([w.status, w.json.coins], [200, 500]);
    assert.strictEqual((await s.call('GET', '/api/v2/admin/users/u1', { token: 'owner' })).json.wallet.coins, 500);
  } finally { await s.stop(); }
});
