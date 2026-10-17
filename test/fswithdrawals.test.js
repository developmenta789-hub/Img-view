'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const { jpeg } = require('./helpers');
const { load } = require('../src/config');
const fsx = require('../src/fswithdrawals');
const { getWallet, applyCoins } = require('../src/fswallet');

const cfg = load({ ADMIN_UIDS: 'owner' });
const user = { uid: 'u1', name: 'Rahul' };
const game = { name: 'Rahul', age18Plus: true, ingameName: 'RahulFF', gameUid: '123456789', gameLevel: 40, gameVerified: true };
const code = (c) => (e) => e.code === c;

async function ready(users = {}, extra = {}) {
  const fs = fakeFs();
  fs.store.set('users/u1', { ...game, ...users });
  await applyCoins(fs, { uid: 'u1', delta: 300, type: 'deposit', ref: 'd1' });
  await applyCoins(fs, { uid: 'u1', delta: 100, winDelta: 100, type: 'prize', ref: 'm1' }); // coins 400, winnings 100
  for (const [k, v] of Object.entries(extra)) fs.store.set(k, v);
  return fs;
}
const proof = () => ({ img: jpeg(3000) });

test('request holds coins and winnings at once and creates a pending withdrawal', async () => {
  const fs = await ready();
  const r = await fsx.createWithdrawal(fs, cfg, user, { amount: 60, payout: 'rahul@upi' });
  assert.deepStrictEqual([r.status, r.coins, r.winCoins], ['pending', 340, 40]);
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 340, winCoins: 40 });
  const d = fs.store.get('withdrawals/' + r.id);
  assert.deepStrictEqual([d.uid, d.amount, d.payout, d.status], ['u1', 60, 'rahul@upi', 'pending']);
  assert.ok(fs.store.has('wallets/u1/ledger/withdraw_hold_' + r.id));
});

test('only winnings can be withdrawn (deposit coins cannot)', async () => {
  const fs = await ready();
  await assert.rejects(fsx.createWithdrawal(fs, cfg, user, { amount: 101, payout: 'rahul@upi' }), code('not_enough_winnings'));
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 400, winCoins: 100 });
  assert.strictEqual([...fs.store.keys()].filter((k) => k.startsWith('withdrawals/')).length, 0);
});

test('refused: bad payout, bad amount, no game details, banned, closed, below minimum', async () => {
  const fs = await ready();
  await assert.rejects(fsx.createWithdrawal(fs, cfg, user, { amount: 10, payout: 'bad' }), code('bad_payout'));
  await assert.rejects(fsx.createWithdrawal(fs, cfg, user, { amount: 0, payout: '9876543210' }), code('bad_amount'));
  await assert.rejects(fsx.createWithdrawal(await ready({ ingameName: '' }), cfg, user, { amount: 10, payout: '9876543210' }), code('game_details'));
  await assert.rejects(fsx.createWithdrawal(await ready({ status: 'banned' }), cfg, user, { amount: 10, payout: '9876543210' }), code('blocked'));
  await assert.rejects(fsx.createWithdrawal(await ready({}, { 'appInfo/main': { withdrawOn: false } }), cfg, user, { amount: 10, payout: '9876543210' }), code('withdraw_off'));
  await assert.rejects(fsx.createWithdrawal(await ready({}, { 'appInfo/main': { withdrawMin: 50 } }), cfg, user, { amount: 10, payout: '9876543210' }), code('below_min'));
});

test('max pending per player', async () => {
  const fs = await ready();
  for (let i = 0; i < cfg.withdrawMaxPending; i++) await fsx.createWithdrawal(fs, cfg, user, { amount: 1, payout: '9876543210' });
  await assert.rejects(fsx.createWithdrawal(fs, cfg, user, { amount: 1, payout: '9876543210' }), code('too_many_pending'));
});

test('reject refunds coins AND winnings once, saves the reason; second review refused', async () => {
  const fs = await ready();
  const r = await fsx.createWithdrawal(fs, cfg, user, { amount: 60, payout: 'rahul@upi' });
  await assert.rejects(fsx.review(fs, cfg, 'owner', r.id, false, { reason: '' }), code('bad_reason'));
  await fsx.review(fs, cfg, 'owner', r.id, false, { reason: 'Wrong UPI ID or number' });
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 400, winCoins: 100 });
  assert.strictEqual(fs.store.get('withdrawals/' + r.id).reason, 'Wrong UPI ID or number');
  await assert.rejects(fsx.review(fs, cfg, 'owner', r.id, false, { reason: 'Again please' }), code('not_pending'));
  await assert.rejects(fsx.review(fs, cfg, 'owner', r.id, true, proof()), code('not_pending'));
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 400, winCoins: 100 });
});

test('paid needs a verified game account and a JPEG screenshot; coins stay held; player can see own proof only', async () => {
  const fs = await ready({ gameVerified: false });
  const r = await fsx.createWithdrawal(fs, cfg, user, { amount: 60, payout: 'rahul@upi' });
  await assert.rejects(fsx.review(fs, cfg, 'owner', r.id, true, proof()), code('not_verified'));
  fs.store.set('users/u1', { ...game });
  await assert.rejects(fsx.review(fs, cfg, 'owner', r.id, true, {}), code('bad_image'));
  await assert.rejects(fsx.review(fs, cfg, 'owner', r.id, true, { img: 'AAAA'.repeat(50) }), code('bad_image'));
  const ok = await fsx.review(fs, cfg, 'owner', r.id, true, proof());
  assert.strictEqual(ok.status, 'approved');
  assert.deepStrictEqual(await getWallet(fs, 'u1'), { coins: 340, winCoins: 40 });
  assert.strictEqual(fs.store.get('withdrawals/' + r.id).reviewedBy, 'owner');
  assert.ok((await fsx.proof(fs, r.id, 'u1', false)).img);
  await assert.rejects(fsx.proof(fs, r.id, 'u2', false), code('not_found'));
  assert.ok((await fsx.proof(fs, r.id, 'owner', true)).img);
});

test('lists, config and settings', async () => {
  const fs = await ready();
  const a = await fsx.createWithdrawal(fs, cfg, user, { amount: 10, payout: '9876543210' });
  await fsx.review(fs, cfg, 'owner', a.id, false, { reason: 'Rule violation' });
  const b = await fsx.createWithdrawal(fs, cfg, user, { amount: 20, payout: '9876543210' });
  assert.strictEqual((await fsx.adminList(fs, '', 50))[0].id, b.id);
  assert.strictEqual((await fsx.adminList(fs, 'rejected', 50)).length, 1);
  assert.strictEqual((await fsx.listMine(fs, 'u1')).length, 2);
  assert.deepStrictEqual(await fsx.withdrawConfig(fs, 'u1'), { withdrawOn: true, min: 1, winCoins: 80 });
  await assert.rejects(fsx.setWithdrawSettings(fs, { withdrawMin: -1 }), code('bad_value'));
  await assert.rejects(fsx.setWithdrawSettings(fs, {}), code('bad_value'));
  await fsx.setWithdrawSettings(fs, { withdrawOn: false, withdrawMin: 100 });
  assert.deepStrictEqual(await fsx.withdrawConfig(fs, 'u1'), { withdrawOn: false, min: 100, winCoins: 80 });
});
