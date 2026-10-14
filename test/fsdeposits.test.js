'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const { jpeg } = require('./helpers');
const { load } = require('../src/config');
const fsd = require('../src/fsdeposits');
const { getWallet } = require('../src/fswallet');

const cfg = load({ ADMIN_UIDS: 'owner' });
const user = { uid: 'u1', name: 'Rahul' };

function ready(extra = {}) {
  const fs = fakeFs();
  fs.store.set('users/u1', { name: 'Rahul', age18Plus: true });
  fs.store.set('paymentInfo/deposit', { slot: 'deposit', upiId: 'shop@bank' });
  for (const [k, v] of Object.entries(extra)) fs.store.set(k, v);
  return fs;
}
const shot = (amount = 100) => ({ amount, img: jpeg(3000), thumb: jpeg(500) });
const errCode = (code) => (e) => e.code === code;

test('submit creates deposit + proof, pending, id is the SHA-256 made by the server', async () => {
  const fs = ready();
  const r = await fsd.createDeposit(fs, cfg, user, shot(100));
  assert.strictEqual(r.status, 'pending'); assert.match(r.id, /^[0-9a-f]{64}$/);
  assert.strictEqual(fs.store.get('deposits/' + r.id).status, 'pending');
  assert.ok(fs.store.get('depositProofs/' + r.id).img);
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 0);
});

test('same screenshot twice is refused', async () => {
  const fs = ready(); const s = shot(50);
  await fsd.createDeposit(fs, cfg, user, s);
  await assert.rejects(fsd.createDeposit(fs, cfg, { uid: 'u2', name: 'X' }, s), errCode('duplicate_screenshot'));
});

test('refused: no profile / not 18+ / banned / deposit off / no payment info', async () => {
  await assert.rejects(fsd.createDeposit(ready(), cfg, { uid: 'ghost', name: 'G' }, shot()), errCode('no_profile'));
  await assert.rejects(fsd.createDeposit(ready({ 'users/u1': { name: 'R', age18Plus: false } }), cfg, user, shot()), errCode('no_profile'));
  await assert.rejects(fsd.createDeposit(ready({ 'users/u1': { name: 'R', age18Plus: true, status: 'banned' } }), cfg, user, shot()), errCode('blocked'));
  await assert.rejects(fsd.createDeposit(ready({ 'appInfo/main': { depositOn: false } }), cfg, user, shot()), errCode('deposit_off'));
  const fs = ready(); fs.store.delete('paymentInfo/deposit');
  await assert.rejects(fsd.createDeposit(fs, cfg, user, shot()), errCode('no_payment_info'));
});

test('amount rules and daily limit (rejected deposits do not count)', async () => {
  const fs = ready({ 'appInfo/main': { depositDailyLimit: 100 } });
  await assert.rejects(fsd.createDeposit(fs, cfg, user, shot(5)), errCode('bad_amount'));
  await assert.rejects(fsd.createDeposit(fs, cfg, user, shot(99999)), errCode('bad_amount'));
  const a = await fsd.createDeposit(fs, cfg, user, shot(60));
  await assert.rejects(fsd.createDeposit(fs, cfg, user, shot(50)), errCode('limit_exceeded'));
  await fsd.review(fs, 'owner', a.id, false, 'Payment not received');
  await fsd.createDeposit(fs, cfg, user, shot(100));
  const c = await fsd.depositConfig(fs, cfg, 'u1');
  assert.strictEqual(c.usedToday, 100); assert.strictEqual(c.dailyLimit, 100); assert.strictEqual(c.upiId, 'shop@bank');
});

test('max pending per user', async () => {
  const fs = ready();
  for (let i = 0; i < cfg.depositMaxPending; i++) await fsd.createDeposit(fs, cfg, user, shot(10));
  await assert.rejects(fsd.createDeposit(fs, cfg, user, shot(10)), errCode('too_many_pending'));
});

test('approve adds coins once, with ledger; second approve or reject is refused', async () => {
  const fs = ready();
  const d = await fsd.createDeposit(fs, cfg, user, shot(200));
  const r = await fsd.review(fs, 'owner', d.id, true);
  assert.deepStrictEqual([r.status, r.coins], ['approved', 200]);
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 200);
  assert.ok(fs.store.has('wallets/u1/ledger/deposit_' + d.id));
  assert.strictEqual(fs.store.get('deposits/' + d.id).reviewedBy, 'owner');
  await assert.rejects(fsd.review(fs, 'owner', d.id, true), errCode('not_pending'));
  await assert.rejects(fsd.review(fs, 'owner', d.id, false, 'Duplicate request'), errCode('not_pending'));
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 200);
});

test('reject needs a 3..120 char reason, gives no coins, reason is saved', async () => {
  const fs = ready();
  const d = await fsd.createDeposit(fs, cfg, user, shot(80));
  await assert.rejects(fsd.review(fs, 'owner', d.id, false, ''), errCode('bad_reason'));
  await assert.rejects(fsd.review(fs, 'owner', d.id, false, 'x'.repeat(121)), errCode('bad_reason'));
  await fsd.review(fs, 'owner', d.id, false, 'Wrong amount paid');
  assert.strictEqual(fs.store.get('deposits/' + d.id).reason, 'Wrong amount paid');
  assert.strictEqual((await getWallet(fs, 'u1')).coins, 0);
  const mine = await fsd.listMine(fs, 'u1');
  assert.strictEqual(mine[0].status, 'rejected'); assert.strictEqual(mine[0].reason, 'Wrong amount paid');
});

test('admin list puts pending first, proof is returned, unknown id is 404', async () => {
  const fs = ready();
  const a = await fsd.createDeposit(fs, cfg, user, shot(10));
  await fsd.review(fs, 'owner', a.id, true);
  const b = await fsd.createDeposit(fs, cfg, user, shot(20));
  const list = await fsd.adminList(fs, '', 50);
  assert.strictEqual(list[0].id, b.id);
  assert.strictEqual((await fsd.adminList(fs, 'approved', 50)).length, 1);
  assert.ok((await fsd.adminProof(fs, b.id)).img);
  await assert.rejects(fsd.adminProof(fs, 'f'.repeat(64)), errCode('not_found'));
  await assert.rejects(fsd.review(fs, 'owner', 'f'.repeat(64), true), errCode('not_found'));
});

test('payment info and deposit settings validate input and write the right documents', async () => {
  const fs = fakeFs();
  await assert.rejects(fsd.setPaymentInfo(fs, { upiId: 'bad' }), errCode('bad_upi'));
  await assert.rejects(fsd.setPaymentInfo(fs, { upiId: 'ab@bank', qrUrl: 'http://x' }), errCode('bad_qr'));
  await fsd.setPaymentInfo(fs, { upiId: 'shop@bank', qrUrl: 'https://x.y/qr.png' });
  assert.strictEqual(fs.store.get('paymentInfo/deposit').slot, 'deposit');
  await assert.rejects(fsd.setDepositSettings(fs, { dailyLimit: -1 }), errCode('bad_value'));
  await assert.rejects(fsd.setDepositSettings(fs, {}), errCode('bad_value'));
  await fsd.setDepositSettings(fs, { depositOn: false, dailyLimit: 500 });
  assert.deepStrictEqual([fs.store.get('appInfo/main').depositOn, fs.store.get('appInfo/main').depositDailyLimit], [false, 500]);
  await fsd.deletePaymentInfo(fs);
  assert.ok(!fs.store.has('paymentInfo/deposit'));
});
