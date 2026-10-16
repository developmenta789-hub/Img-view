'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const { joinTournament } = require('../src/fsmatches');
const { getWallet, applyCoins } = require('../src/fswallet');

const game = { name: 'P', age18Plus: true, ingameName: 'RahulFF', gameUid: '123456789', gameLevel: 40 };
const code = (c) => (e) => e.code === c;
const u1 = { uid: 'u1', name: 'Rahul' };
const future = () => new Date(Date.now() + 3600000);

async function ready({ match = {}, user = {}, coins = 500, win = 0, extra = {} } = {}) {
  const fs = fakeFs();
  fs.store.set('tournaments/m1', { title: 'T', category: 'br', status: 'upcoming', entryFee: 50, maxPlayers: 4, joined: 0, startTime: future(), ...match });
  fs.store.set('users/u1', { ...game, ...user });
  fs.store.set('users/u2', { ...game, ingameName: 'Second' });
  if (coins) await applyCoins(fs, { uid: 'u1', delta: coins, winDelta: win, type: 'seed', ref: 's1' });
  for (const [k, v] of Object.entries(extra)) fs.store.set(k, v);
  return fs;
}

test('join writes registration, slot, joined+1 and takes the fee; name = in-game name', async () => {
  const fs = await ready();
  const r = await joinTournament(fs, u1, 'm1', { slot: 2 });
  assert.deepStrictEqual([r.slot, r.fee, r.joined, r.coins], [2, 50, 1, 450]);
  const reg = fs.store.get('registrations/m1_u1');
  assert.deepStrictEqual([reg.uid, reg.name, reg.fee, reg.slot, reg.winPart], ['u1', 'RahulFF', 50, 2, undefined]);
  assert.strictEqual(fs.store.get('tournaments/m1/slots/2').uid, 'u1');
  assert.strictEqual(fs.store.get('tournaments/m1').joined, 1);
  assert.ok(fs.store.has('wallets/u1/ledger/join_fee_m1_u1'));
});

test('fee uses deposit coins first and winnings last (winPart saved)', async () => {
  const fs = await ready({ coins: 100, win: 80 });          // 20 deposit + 80 winnings
  await joinTournament(fs, u1, 'm1', { slot: 1 });
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 50, winCoins: 50 });
  assert.strictEqual(fs.store.get('registrations/m1_u1').winPart, 30);
});

test('free match does not touch the wallet', async () => {
  const fs = await ready({ match: { entryFee: 0 }, coins: 0 });
  const r = await joinTournament(fs, u1, 'm1', { slot: 3 });
  assert.strictEqual(r.coins, null);
  assert.ok(!fs.store.has('wallets/u1'));
});

test('not enough coins: nothing is written', async () => {
  const fs = await ready({ coins: 10 });
  await assert.rejects(joinTournament(fs, u1, 'm1', { slot: 1 }), code('not_enough_coins'));
  assert.ok(!fs.store.has('registrations/m1_u1')); assert.ok(!fs.store.has('tournaments/m1/slots/1'));
  assert.strictEqual(fs.store.get('tournaments/m1').joined, 0);
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 10);
});

test('refused: unknown, not upcoming, started, join off, no game details, banned, low level', async () => {
  await assert.rejects(joinTournament(await ready(), u1, 'nope', { slot: 1 }), code('not_found'));
  await assert.rejects(joinTournament(await ready({ match: { status: 'ongoing' } }), u1, 'm1', { slot: 1 }), code('not_open'));
  await assert.rejects(joinTournament(await ready({ match: { startTime: new Date(Date.now() - 1000) } }), u1, 'm1', { slot: 1 }), code('closed'));
  await assert.rejects(joinTournament(await ready({ match: { joinEnabled: false } }), u1, 'm1', { slot: 1 }), code('join_off'));
  await assert.rejects(joinTournament(await ready({ user: { gameUid: '' } }), u1, 'm1', { slot: 1 }), code('game_details'));
  await assert.rejects(joinTournament(await ready({ user: { status: 'banned' } }), u1, 'm1', { slot: 1 }), code('blocked'));
  await assert.rejects(joinTournament(await ready({ extra: { 'appInfo/main': { minGameLevel: 50 } } }), u1, 'm1', { slot: 1 }), code('level_too_low'));
});

test('slot rules: range, taken, already joined, full', async () => {
  const fs = await ready();
  await assert.rejects(joinTournament(fs, u1, 'm1', { slot: 0 }), code('bad_slot'));
  await assert.rejects(joinTournament(fs, u1, 'm1', { slot: 5 }), code('bad_slot'));
  await assert.rejects(joinTournament(fs, u1, 'm1', {}), code('bad_slot'));
  await joinTournament(fs, u1, 'm1', { slot: 1 });
  await assert.rejects(joinTournament(fs, u1, 'm1', { slot: 2 }), code('already_joined'));
  await applyCoins(fs, { uid: 'u2', delta: 500, type: 'seed', ref: 's2' });
  await assert.rejects(joinTournament(fs, { uid: 'u2', name: 'S' }, 'm1', { slot: 1 }), code('slot_taken'));
  assert.strictEqual((await getWallet(fs, 'u2')).coins, 500);
  const full = await ready({ match: { joined: 4 } });
  await assert.rejects(joinTournament(full, u1, 'm1', { slot: 1 }), code('full'));
});

test('invited seat: only the invited player can take it, and the invite is used up', async () => {
  const fs = await ready({ extra: { 'slotInvites/m1_3': { tournamentId: 'm1', slot: 3, fromUid: 'u2', toUid: 'u1' } } });
  await applyCoins(fs, { uid: 'u3', delta: 500, type: 'seed', ref: 's3' });
  fs.store.set('users/u3', { ...game, ingameName: 'Third' });
  await assert.rejects(joinTournament(fs, { uid: 'u3', name: 'T' }, 'm1', { slot: 3 }), code('slot_reserved'));
  assert.ok(fs.store.has('slotInvites/m1_3'));
  await joinTournament(fs, u1, 'm1', { slot: 3 });
  assert.ok(!fs.store.has('slotInvites/m1_3'));
});

test('HTTP join route needs login', async () => {
  const { start } = require('./helpers');
  const fs = await ready();
  const s = await start({}, fs);
  try {
    assert.strictEqual((await s.call('POST', '/api/v2/tournaments/m1/join', { body: { slot: 1 } })).status, 401);
    const ok = await s.call('POST', '/api/v2/tournaments/m1/join', { token: 'u1', body: { slot: 1 } });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.joined, 1);
    assert.strictEqual((await s.call('POST', '/api/v2/tournaments/m1/join', { token: 'u1', body: { slot: 2 } })).json.error, 'already_joined');
  } finally { await s.stop(); }
});
