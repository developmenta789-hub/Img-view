'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const { creditPrizes, completeMatch } = require('../src/fsresults');
const { getWallet, applyCoins } = require('../src/fswallet');
const { weekKey } = require('../src/weekkey');

const code = (c) => (e) => e.code === c;
const NOW = new Date('2026-10-14T10:00:00Z');           // Wednesday, week 2026-10-12
const now = () => NOW;

async function ready({ match = {}, extra = {} } = {}) {
  const fs = fakeFs();
  fs.store.set('tournaments/m1', { title: 'Night Cup', status: 'ongoing', prizePool: 100, joined: 4, ...match });
  for (const u of ['u1', 'u2', 'u3', 'u4']) fs.store.set('registrations/m1_' + u, { tournamentId: 'm1', uid: u, name: 'P' + u, fee: 10, slot: 1 });
  for (const [k, v] of Object.entries(extra)) fs.store.set(k, v);
  return fs;
}

test('weekKey: Monday date in India time', () => {
  assert.strictEqual(weekKey(Date.parse('2026-10-14T10:00:00Z')), '2026-10-12');
  assert.strictEqual(weekKey(Date.parse('2026-10-18T18:29:00Z')), '2026-10-12');   // Sunday 23:59 IST
  assert.strictEqual(weekKey(Date.parse('2026-10-18T18:30:00Z')), '2026-10-19');   // Monday 00:00 IST
  assert.strictEqual(weekKey(Date.parse('2026-10-12T18:29:00Z')), '2026-10-12');
});

test('credit: prize goes to winnings, result row + prizeCredit + both leaderboards', async () => {
  const fs = await ready();
  const r = await creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 2, coins: 60 }, { uid: 'u2', kills: 1, coins: 20 }], now);
  assert.deepStrictEqual([r.saved, r.credited, r.week, r.skipped.length], [2, 80, '2026-10-12', 0]);
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 60, winCoins: 60 });
  assert.ok(fs.store.has('wallets/u1/ledger/prize_m1_u1'));
  const pc = fs.store.get('prizeCredits/m1_u1');
  assert.deepStrictEqual([pc.uid, pc.amount, pc.tournamentTitle], ['u1', 60, 'Night Cup']);
  const rp = fs.store.get('results/m1/players/u1');
  assert.deepStrictEqual([rp.kills, rp.winning, rp.name], [2, 60, 'Pu1']);
  assert.deepStrictEqual(fs.store.get('leaderboard/u1'), { name: 'Pu1', points: 60 + 10, kills: 2, wins: 1 });
  assert.deepStrictEqual(fs.store.get('leaderboardWeeks/2026-10-12/players/u2'), { name: 'Pu2', points: 20 + 5, kills: 1, wins: 0 });
});

test('kills only (0 coins): result row and leaderboard, no wallet, no prizeCredit', async () => {
  const fs = await ready();
  await creditPrizes(fs, 'm1', [{ uid: 'u3', kills: 3, coins: 0 }], now);
  assert.ok(!fs.store.has('wallets/u3')); assert.ok(!fs.store.has('prizeCredits/m1_u3'));
  assert.strictEqual(fs.store.get('results/m1/players/u3').kills, 3);
  assert.strictEqual(fs.store.get('leaderboard/u3').points, 15);
});

test('a player is never paid twice: same list again is skipped, leaderboard unchanged', async () => {
  const fs = await ready();
  const list = [{ uid: 'u1', kills: 2, coins: 60 }];
  await creditPrizes(fs, 'm1', list, now);
  const again = await creditPrizes(fs, 'm1', list, now);
  assert.deepStrictEqual([again.saved, again.skipped, again.credited], [0, ['u1'], 0]);
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 60);
  assert.strictEqual(fs.store.get('leaderboard/u1').points, 70);
});

test('limits are enforced: pool, kills, not joined, status, bad numbers, empty row', async () => {
  const fs = await ready();
  await assert.rejects(creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 0, coins: 101 }], now), code('over_pool'));
  await assert.rejects(creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 4, coins: 10 }], now), code('too_many_kills'));
  await assert.rejects(creditPrizes(fs, 'm1', [{ uid: 'zz', kills: 1, coins: 10 }], now), code('not_joined'));
  await assert.rejects(creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 1.5, coins: 10 }], now), code('bad_kills'));
  await assert.rejects(creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 0, coins: -5 }], now), code('bad_coins'));
  await assert.rejects(creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 0, coins: 0 }], now), code('empty_row'));
  await assert.rejects(creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 1, coins: 1 }, { uid: 'u1', kills: 1, coins: 1 }], now), code('bad_players'));
  await assert.rejects(creditPrizes(fs, 'm1', [], now), code('bad_players'));
  await assert.rejects(creditPrizes(fs, 'nope', [{ uid: 'u1', kills: 1, coins: 1 }], now), code('not_found'));
  await assert.rejects(creditPrizes(await ready({ match: { status: 'upcoming' } }), 'm1', [{ uid: 'u1', kills: 1, coins: 1 }], now), code('not_started'));
  await assert.rejects(creditPrizes(await ready({ match: { status: 'cancelled' } }), 'm1', [{ uid: 'u1', kills: 1, coins: 1 }], now), code('cancelled'));
  assert.ok(!fs.store.has('results/m1/players/u1'));            // nothing was written by any refused call
});

test('pool counts what was already saved earlier', async () => {
  const fs = await ready();
  await creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 0, coins: 90 }], now);
  await assert.rejects(creditPrizes(fs, 'm1', [{ uid: 'u2', kills: 0, coins: 20 }], now), code('over_pool'));
  const ok = await creditPrizes(fs, 'm1', [{ uid: 'u2', kills: 0, coins: 10 }], now);
  assert.strictEqual(ok.totalCoins, 100);
});

test('win flag: only the top coins of the whole match gets a win (also vs earlier saved rows)', async () => {
  const fs = await ready();
  await creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 0, coins: 50 }], now);
  await creditPrizes(fs, 'm1', [{ uid: 'u2', kills: 0, coins: 30 }], now);
  assert.strictEqual(fs.store.get('leaderboard/u1').wins, 1);
  assert.strictEqual(fs.store.get('leaderboard/u2').wins, 0);
});

test('stopped half way: earlier players stay saved, the same list continues', async () => {
  const fs = await ready();
  const real = fs.runTransaction.bind(fs); let n = 0;
  fs.runTransaction = (fn) => (++n === 2 ? Promise.reject(new Error('boom')) : real(fn));
  const list = [{ uid: 'u1', kills: 0, coins: 10 }, { uid: 'u2', kills: 0, coins: 10 }];
  await assert.rejects(creditPrizes(fs, 'm1', list, now), (e) => e.code === 'partial_save' && /1 player/.test(e.message));
  fs.runTransaction = real;
  const r = await creditPrizes(fs, 'm1', list, now);
  assert.deepStrictEqual([r.saved, r.skipped], [1, ['u1']]);
  assert.strictEqual((await getWallet(fs, 'u2')).coins, 10);
});

test('complete: ongoing -> completed with summary (places, top killer); a second call is refused', async () => {
  const fs = await ready();
  await creditPrizes(fs, 'm1', [{ uid: 'u1', kills: 0, coins: 50 }, { uid: 'u2', kills: 3, coins: 30 }, { uid: 'u3', kills: 0, coins: 10 }], now);
  const c = await completeMatch(fs, 'm1', now);
  assert.deepStrictEqual([c.status, c.summary], ['completed', true]);
  assert.strictEqual(fs.store.get('tournaments/m1').status, 'completed');
  const s = fs.store.get('results/m1');
  assert.deepStrictEqual([s.place1, s.place2, s.place3, s.topKiller, s.topKills, s.tournamentTitle], ['Pu1', 'Pu2', 'Pu3', 'Pu2', 3, 'Night Cup']);
  await assert.rejects(completeMatch(fs, 'm1', now), code('already_completed'));
});

test('complete without prizes: status changes, no summary; refused when upcoming or cancelled', async () => {
  const fs = await ready();
  const c = await completeMatch(fs, 'm1', now);
  assert.deepStrictEqual([c.status, c.summary], ['completed', false]);
  assert.ok(!fs.store.has('results/m1'));
  await assert.rejects(completeMatch(await ready({ match: { status: 'upcoming' } }), 'm1', now), code('not_started'));
  await assert.rejects(completeMatch(await ready({ match: { status: 'cancelled' } }), 'm1', now), code('cancelled'));
  await assert.rejects(completeMatch(fs, 'nope', now), code('not_found'));
});

test('credit is still allowed after complete (the Admin "Credit" on a completed match)', async () => {
  const fs = await ready();
  await completeMatch(fs, 'm1', now);
  const r = await creditPrizes(fs, 'm1', [{ uid: 'u4', kills: 0, coins: 25 }], now);
  assert.strictEqual(r.saved, 1);
});

test('HTTP: admin only, result + complete in one call', async () => {
  const { start } = require('./helpers');
  const fs = await ready();
  const s = await start({}, fs);
  try {
    const body = { players: [{ uid: 'u1', kills: 1, coins: 40 }], complete: true };
    assert.strictEqual((await s.call('POST', '/api/v2/admin/tournaments/m1/result', { body })).status, 401);
    assert.strictEqual((await s.call('POST', '/api/v2/admin/tournaments/m1/result', { token: 'u1', body })).status, 403);
    const ok = await s.call('POST', '/api/v2/admin/tournaments/m1/result', { token: 'owner', body });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual([ok.json.saved, ok.json.credited, ok.json.completed.status], [1, 40, 'completed']);
    assert.strictEqual((await s.call('POST', '/api/v2/admin/tournaments/m1/complete', { token: 'owner', body: {} })).json.error, 'already_completed');
  } finally { await s.stop(); }
});
