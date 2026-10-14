'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyCoins, getWallet, history } = require('../src/fswallet');
const { createAdminCheck } = require('../src/admin');
const { start } = require('./helpers');
const { fakeFs } = require('./fakefs');

test('credit creates wallet and ledger', async () => {
  const fs = fakeFs();
  assert.deepStrictEqual(await applyCoins(fs, { uid: 'u1', delta: 100, type: 'deposit', ref: 'a1' }), { coins: 100, winCoins: 0 });
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 100, winCoins: 0 });
  const h = await history(fs, 'u1', 10);
  assert.strictEqual(h.length, 1); assert.strictEqual(h[0].balanceAfter, 100);
});

test('same (type, ref) cannot be applied twice', async () => {
  const fs = fakeFs();
  await applyCoins(fs, { uid: 'u1', delta: 50, type: 'deposit', ref: 'x' });
  await assert.rejects(applyCoins(fs, { uid: 'u1', delta: 50, type: 'deposit', ref: 'x' }), (e) => e.code === 'already_applied');
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 50);
});

test('cannot go below zero, wallet unchanged', async () => {
  const fs = fakeFs();
  await applyCoins(fs, { uid: 'u1', delta: 10, type: 'deposit', ref: 'a' });
  await assert.rejects(applyCoins(fs, { uid: 'u1', delta: -11, type: 'join_fee', ref: 'm1' }), (e) => e.code === 'not_enough_coins');
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 10);
});

test('winnings: prize adds to winCoins, spend keeps winnings until coins fall below them', async () => {
  const fs = fakeFs();
  await applyCoins(fs, { uid: 'u1', delta: 100, type: 'deposit', ref: 'a' });
  await applyCoins(fs, { uid: 'u1', delta: 40, winDelta: 40, type: 'prize', ref: 'm1' });
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 140, winCoins: 40 });
  assert.deepStrictEqual(await applyCoins(fs, { uid: 'u1', delta: -50, type: 'join_fee', ref: 'm2' }), { coins: 90, winCoins: 40 });
  assert.deepStrictEqual(await applyCoins(fs, { uid: 'u1', delta: -70, type: 'join_fee', ref: 'm3' }), { coins: 20, winCoins: 20 });
});

test('bad input is refused before touching the database', async () => {
  const fs = fakeFs();
  for (const bad of [{ delta: 0 }, { delta: 1.5 }, { delta: 5, type: 'Bad Type' }, { delta: 5, ref: 'a/b' }, { delta: 5, uid: 'a/b' }]) {
    await assert.rejects(applyCoins(fs, { uid: 'u1', delta: 5, type: 'deposit', ref: 'r', ...bad }));
  }
  assert.strictEqual(fs.store.size, 0);
});

test('admin check: env list, admins/{uid} doc, cache, no Firestore', async () => {
  const fs = fakeFs(); let t = 0;
  fs.store.set('admins/boss', {});
  const isAdmin = createAdminCheck({ db: fs, adminUids: new Set(['env']), now: () => t });
  assert.ok(await isAdmin('env')); assert.ok(await isAdmin('boss')); assert.ok(!(await isAdmin('nobody')));
  fs.store.set('admins/nobody', {});
  assert.ok(!(await isAdmin('nobody')));            // cached for 60s
  t = 61000; assert.ok(await isAdmin('nobody'));
  const off = createAdminCheck({ db: null, adminUids: new Set(['env']) });
  assert.ok(await off('env')); assert.ok(!(await off('boss')));
});

test('HTTP v2 wallet routes: need login, answer 503 when Firestore is off', async () => {
  const s = await start({ FIREBASE_SERVICE_ACCOUNT_B64: '' });
  try {
    assert.strictEqual((await s.call('GET', '/api/v2/wallet')).status, 401);
    const r = await s.call('GET', '/api/v2/wallet', { token: 'u1' });
    assert.strictEqual(r.status, 503); assert.strictEqual(r.json.error, 'firestore_off');
  } finally { await s.stop(); }
});

test('HTTP v2 deposit routes: user routes need login, admin routes need admin', async () => {
  const fs = fakeFs();
  fs.store.set('admins/boss', {});
  const s = await start({}, fs);
  try {
    assert.strictEqual((await s.call('GET', '/api/v2/deposit/config')).status, 401);
    assert.strictEqual((await s.call('GET', '/api/v2/admin/deposits', { token: 'u1' })).status, 403);
    assert.strictEqual((await s.call('GET', '/api/v2/admin/deposits', { token: 'boss' })).status, 200);
    assert.strictEqual((await s.call('GET', '/api/v2/admin/deposits', { token: 'owner' })).status, 200);
    assert.strictEqual((await s.call('GET', '/api/v2/deposit/config', { token: 'u1' })).json.depositOn, true);
  } finally { await s.stop(); }
});
