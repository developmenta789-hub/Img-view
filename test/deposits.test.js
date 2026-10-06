'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, shot, jpeg } = require('./helpers');

let s;
before(async () => { s = await start({ DEPOSIT_MAX_PENDING: '3' }); });
after(async () => { await s.stop(); });

const ADMIN = 'owner';
const setUpi = () => s.call('PUT', '/api/admin/payment-info', { token: ADMIN, body: { upiId: 'owner@bank', qrUrl: 'https://example.com/qr.png' } });

test('health + welcome are public', async () => {
  assert.equal((await s.call('GET', '/api/health')).json.ok, true);
  assert.equal((await s.call('GET', '/')).json.ok, true);
});

test('no token / bad token = 401', async () => {
  assert.equal((await s.call('GET', '/api/wallet')).status, 401);
  assert.equal((await s.call('GET', '/api/wallet', { token: 'bad' })).status, 401);
});

test('deposit is refused until the owner sets payment details', async () => {
  const cfg = await s.call('GET', '/api/deposit/config', { token: 'u1' });
  assert.equal(cfg.json.upiId, '');
  const r = await s.call('POST', '/api/deposits', { token: 'u1', body: shot() });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'no_payment_info');
});

test('only the owner can set payment details; bad UPI / QR are refused', async () => {
  assert.equal((await s.call('PUT', '/api/admin/payment-info', { token: 'u1', body: { upiId: 'a@b1' } })).status, 403);
  assert.equal((await s.call('PUT', '/api/admin/payment-info', { token: ADMIN, body: { upiId: 'no-at-sign' } })).json.error, 'bad_upi');
  assert.equal((await s.call('PUT', '/api/admin/payment-info', { token: ADMIN, body: { upiId: 'ok@bank', qrUrl: 'http://x.com/q.png' } })).json.error, 'bad_qr');
  assert.equal((await setUpi()).status, 200);
  const cfg = await s.call('GET', '/api/deposit/config', { token: 'u1' });
  assert.equal(cfg.json.upiId, 'owner@bank');
  assert.equal(cfg.json.qrUrl, 'https://example.com/qr.png');
  assert.equal(cfg.json.depositOn, true);
  assert.equal(cfg.json.min, 10);
  assert.equal((await s.call('GET', '/api/payment-info', { token: 'u1' })).json.paymentInfo.upiId, 'owner@bank');
});

test('submit a deposit, same screenshot twice = 409, id is the SHA-256 made by the server', async () => {
  const body = shot(100);
  const r = await s.call('POST', '/api/deposits', { token: 'u2:Asha', body });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, crypto.createHash('sha256').update(Buffer.from(body.img, 'base64')).digest('hex'));
  const again = await s.call('POST', '/api/deposits', { token: 'u2:Asha', body });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'duplicate_screenshot');
  // another user, same screenshot: still refused
  assert.equal((await s.call('POST', '/api/deposits', { token: 'u3', body })).status, 409);
});

test('bad amount / bad image are refused', async () => {
  let n = 0;
  const tok = () => 'bad-' + (n++);   // a new user per call, so the per-user rate limit does not interfere
  for (const amount of [0, -5, 9, 10001, 12.5, 'abc', null]) {
    const r = await s.call('POST', '/api/deposits', { token: tok(), body: { ...shot(), amount } });
    assert.equal(r.status, 400, 'amount ' + amount);
  }
  assert.equal((await s.call('POST', '/api/deposits', { token: tok(), body: { ...shot(), img: 'not base64!!' } })).json.error, 'bad_image');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(500)]).toString('base64');
  assert.equal((await s.call('POST', '/api/deposits', { token: tok(), body: { ...shot(), img: png } })).json.error, 'bad_image');
  assert.equal((await s.call('POST', '/api/deposits', { token: tok(), body: { ...shot(), thumb: png } })).json.error, 'bad_image');
  assert.equal((await s.call('POST', '/api/deposits', { token: tok(), body: { amount: 50 } })).status, 400);
});

test('owner list shows thumb but never the full image; proof has the image', async () => {
  const list = await s.call('GET', '/api/admin/deposits', { token: ADMIN });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  const it = list.json.items[0];
  assert.equal(it.status, 'pending'); assert.equal(it.name, 'Asha'); assert.equal(it.amount, 100);
  assert.ok(it.thumb.length > 100); assert.equal(it.img, undefined);
  assert.equal((await s.call('GET', '/api/admin/deposits', { token: 'u2' })).status, 403);
  const proof = await s.call('GET', `/api/admin/deposits/${it.id}/proof`, { token: ADMIN });
  assert.ok(proof.json.img.length > 1000);
  assert.equal((await s.call('GET', `/api/admin/deposits/${it.id}/proof`, { token: 'u2' })).status, 403);
});

test('approve adds coins exactly once; second approve / reject = 409', async () => {
  const id = (await s.call('GET', '/api/admin/deposits', { token: ADMIN })).json.items[0].id;
  assert.equal((await s.call('POST', `/api/admin/deposits/${id}/approve`, { token: 'u2' })).status, 403);
  assert.equal((await s.call('GET', '/api/wallet', { token: 'u2' })).json.coins, 0);
  const ok = await s.call('POST', `/api/admin/deposits/${id}/approve`, { token: ADMIN });
  assert.equal(ok.status, 200); assert.equal(ok.json.coins, 100);
  assert.equal((await s.call('POST', `/api/admin/deposits/${id}/approve`, { token: ADMIN })).status, 409);
  assert.equal((await s.call('POST', `/api/admin/deposits/${id}/reject`, { token: ADMIN })).status, 409);
  const w = await s.call('GET', '/api/wallet', { token: 'u2' });
  assert.equal(w.json.coins, 100); assert.equal(w.json.winCoins, 0);
  const h = await s.call('GET', '/api/wallet/history', { token: 'u2' });
  assert.equal(h.json.items.length, 1); assert.equal(h.json.items[0].delta, 100); assert.equal(h.json.items[0].type, 'deposit');
});

test('reject adds nothing and frees the daily limit', async () => {
  await s.call('PUT', '/api/admin/deposit-settings', { token: ADMIN, body: { dailyLimit: 500 } });
  const a = await s.call('POST', '/api/deposits', { token: 'u5', body: shot(400) });
  assert.equal(a.status, 200);
  const over = await s.call('POST', '/api/deposits', { token: 'u5', body: shot(200) });
  assert.equal(over.status, 400); assert.equal(over.json.error, 'limit_exceeded');
  assert.equal((await s.call('GET', '/api/deposit/config', { token: 'u5' })).json.usedToday, 400);
  await s.call('POST', `/api/admin/deposits/${a.json.id}/reject`, { token: ADMIN });
  assert.equal((await s.call('GET', '/api/wallet', { token: 'u5' })).json.coins, 0);
  assert.equal((await s.call('GET', '/api/deposit/config', { token: 'u5' })).json.usedToday, 0);
  assert.equal((await s.call('POST', '/api/deposits', { token: 'u5', body: shot(200) })).status, 200);
  await s.call('PUT', '/api/admin/deposit-settings', { token: ADMIN, body: { dailyLimit: 0 } });
});

test('too many pending requests = 429', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/deposits', { token: 'u6', body: shot(20) })).status, 200);
  const r = await s.call('POST', '/api/deposits', { token: 'u6', body: shot(20) });
  assert.equal(r.status, 429); assert.equal(r.json.error, 'too_many_pending');
});

test('owner switch: deposits off = 403, back on = works', async () => {
  assert.equal((await s.call('PUT', '/api/admin/deposit-settings', { token: 'u1', body: { depositOn: false } })).status, 403);
  assert.equal((await s.call('PUT', '/api/admin/deposit-settings', { token: ADMIN, body: { depositOn: 'no' } })).status, 400);
  await s.call('PUT', '/api/admin/deposit-settings', { token: ADMIN, body: { depositOn: false } });
  assert.equal((await s.call('GET', '/api/deposit/config', { token: 'u7' })).json.depositOn, false);
  const r = await s.call('POST', '/api/deposits', { token: 'u7', body: shot() });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'deposit_off');
  await s.call('PUT', '/api/admin/deposit-settings', { token: ADMIN, body: { depositOn: true } });
  assert.equal((await s.call('POST', '/api/deposits', { token: 'u7', body: shot() })).status, 200);
});

test('a user sees only own deposits (no screenshot data)', async () => {
  const mine = await s.call('GET', '/api/deposits/mine', { token: 'u2' });
  assert.equal(mine.json.items.length, 1);
  assert.equal(mine.json.items[0].status, 'approved');
  assert.equal(mine.json.items[0].img, undefined); assert.equal(mine.json.items[0].thumb, undefined);
  assert.equal((await s.call('GET', '/api/deposits/mine', { token: 'nobody' })).json.items.length, 0);
});

test('owner can delete payment details', async () => {
  assert.equal((await s.call('DELETE', '/api/admin/payment-info', { token: ADMIN })).status, 200);
  assert.equal((await s.call('GET', '/api/deposit/config', { token: 'u1' })).json.upiId, '');
  await setUpi();
});

test('bad json, unknown route, huge body', async () => {
  const bad = await fetch(s.base + '/api/deposits', { method: 'POST', headers: { Authorization: 'Bearer u8', 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await s.call('GET', '/api/nothing')).status, 404);
  const huge = await fetch(s.base + '/api/deposits', { method: 'POST', headers: { Authorization: 'Bearer u8', 'Content-Type': 'application/json' }, body: JSON.stringify({ img: 'A'.repeat(700 * 1024) }) }).catch(() => ({ status: 413 }));
  assert.equal(huge.status, 413);
});

test('owner backup is a real SQLite file; users cannot download it', async () => {
  assert.equal((await s.call('GET', '/api/admin/backup', { token: 'u2' })).status, 403);
  const r = await s.call('GET', '/api/admin/backup', { token: ADMIN });
  assert.equal(r.status, 200);
  assert.ok(r.text.startsWith('SQLite format 3'));
});

test('session creates the user and tells who is the owner', async () => {
  const r = await s.call('POST', '/api/auth/session', { token: ADMIN + ':Boss' });
  assert.equal(r.json.isAdmin, true);
  assert.equal((await s.call('POST', '/api/auth/session', { token: 'u2' })).json.isAdmin, false);
});

test('jpeg helper gives different bytes each call (test sanity)', () => { assert.notEqual(jpeg(), jpeg()); });
