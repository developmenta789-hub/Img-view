'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const ev = require('../src/fsevasion');
const fsu = require('../src/fsusers');
const { start } = require('./helpers');

const code = (c) => (e) => e.code === c;
const game = { name: 'Rahul', age18Plus: true };

test('helpers: e-mail key, nickname similarity', () => {
  assert.strictEqual(ev.emailKey('Rah.ul+x@GMail.com'), 'rahul@gmail.com');
  assert.strictEqual(ev.emailKey('a.b@corp.com'), 'a.b@corp.com');
  assert.ok(ev.nickSimilar('THE"LEGEND"', 'The_Legend'));
  assert.ok(ev.nickSimilar('PDV_SARKAR', 'PDV SARKAR 07'));
  assert.ok(ev.nickSimilar('R0C-93', 'ROC93'));
  assert.ok(ev.nickSimilar('TANISH_RANDA', 'TANISH_RANDAA'));
  assert.ok(!ev.nickSimilar('TANISH_RANDA', 'SURAJ_KING'));
  assert.ok(!ev.nickSimilar('abc', 'abd'));
  // same name or small changes of any kind
  for (const [x, y] of [['KingX', 'KingX'], ['KingX', 'kingx'], ['KingX', 'KiNgGgX'], ['KingX', 'KingX07'], ['KingX', '007_KingX'], ['KingX', 'KYNGX'], ['KingX', 'KingXX'],
    ['KingX', 'KinXg'], ['KingX', 'TEAM_KingX'], ['KingX', '\u{1D542}\u{1D55A}\u{1D55F}\u{1D558}\u{1D54F}'], ['KingX', 'K\u0456ngX'], ['KingX', 'K.i.n.g.X'], ['KingX', 'K I N G X'], ['SARKAR_07', 'Sarkr'],
    ['PDV_SARKAR', 'PDV-SARKAAR'], ['Legend', 'L3g3nd'], ['THE"LEGEND"', 'Th3 L3gend_xx']]) assert.ok(ev.nickSimilar(x, y), x + ' ~ ' + y);
  for (const [x, y] of [['KingX', 'SurajOP'], ['TANISH_RANDA', 'PDV_SARKAR'], ['Rahul', 'Rohan_FF'], ['Alpha', 'Omega']]) assert.ok(!ev.nickSimilar(x, y), x + ' !~ ' + y);
});

test('setStatus writes banLocks, active removes it', async () => {
  const fs = fakeFs();
  fs.store.set('users/b1', { ...game, email: 'bad@gmail.com', ingameName: 'KingX', gameUid: '111111111' });
  await fsu.setStatus(fs, 'b1', { status: 'banned', reason: 'cheating' });
  assert.strictEqual(fs.store.get('banLocks/b1').emailKey, 'bad@gmail.com');
  await fsu.setStatus(fs, 'b1', { status: 'active' });
  assert.strictEqual(fs.store.has('banLocks/b1'), false);
});

test('new account with the same e-mail / game UID / similar nickname is refused; 3 tries ban it', async () => {
  const fs = fakeFs();
  fs.store.set('users/b1', { ...game, email: 'bad@gmail.com', ingameName: 'KingX', gameUid: '111111111' });
  await fsu.setStatus(fs, 'b1', { status: 'banned', reason: 'cheating' });
  // fresh signup, same e-mail (dots + tag): refused, profile not created
  fs.store.set('users/n1', { ...game, email: 'b.ad+2@gmail.com' });
  let r = await ev.checkIdentity(fs, 'n1', {});
  assert.deepStrictEqual([r.ok, r.by, r.banned], [false, 'email', false]);
  assert.strictEqual(fs.store.has('users/n1'), false);
  // other e-mail, same game UID about to be saved
  fs.store.set('users/n2', { ...game, email: 'other@gmail.com' });
  r = await ev.checkIdentity(fs, 'n2', { ingameName: 'Zed', gameUid: '111111111' });
  assert.deepStrictEqual([r.ok, r.by], [false, 'game_uid']);
  // similar nickname
  fs.store.set('users/n3', { ...game, email: 'third@gmail.com', ingameName: 'K1ngX_' });
  r = await ev.checkIdentity(fs, 'n3', {});
  assert.deepStrictEqual([r.ok, r.by], [false, 'nickname']);
  // clean player is fine
  fs.store.set('users/ok', { ...game, email: 'fine@gmail.com', ingameName: 'Suraj', gameUid: '222222222' });
  assert.strictEqual((await ev.checkIdentity(fs, 'ok', {})).ok, true);
  // forcing again with the same e-mail: strikes 2, then 3 = banned + locked
  fs.store.set('users/n1', { ...game, email: 'bad@gmail.com' });
  r = await ev.checkIdentity(fs, 'n1', {});
  assert.deepStrictEqual([r.banned, r.strikes], [false, 2]);
  fs.store.set('users/n1', { ...game, email: 'bad@gmail.com' });
  r = await ev.checkIdentity(fs, 'n1', {});
  assert.deepStrictEqual([r.banned, r.strikes], [true, 3]);
  assert.strictEqual(fs.store.get('users/n1').status, 'banned');
  assert.ok(fs.store.has('banLocks/n1'));
});

test('suspension that is over no longer blocks new accounts', async () => {
  const fs = fakeFs();
  fs.store.set('banLocks/s1', { uid: 's1', status: 'suspended', until: Date.now() - 1000, emailKey: 'sus@gmail.com', gameUid: '', nick: '', nickKey: '' });
  fs.store.set('users/n1', { ...game, email: 'sus@gmail.com' });
  assert.strictEqual((await ev.checkIdentity(fs, 'n1', {})).ok, true);
});

test('server: matching account is closed on every route; /me/check explains; rebuild makes locks for old bans', async () => {
  const fs = fakeFs();
  fs.store.set('admins/owner', {});
  fs.store.set('users/old', { ...game, email: 'old@gmail.com', ingameName: 'OldKing', gameUid: '333333333', status: 'banned', statusReason: 'hack' });
  fs.store.set('users/new', { ...game, email: 'o.l.d@gmail.com', ingameName: 'Fresh' });
  const s = await start({}, fs);
  try {
    assert.deepStrictEqual((await s.call('POST', '/api/v2/admin/ban-locks/rebuild', { token: 'owner', body: {} })).json, { locks: 1 });
    let r = await s.call('GET', '/api/v2/wallet', { token: 'new' });
    assert.deepStrictEqual([r.status, r.json.error], [403, 'ban_evasion']);
    r = await s.call('POST', '/api/v2/me/check', { token: 'new', body: {} });
    assert.deepStrictEqual([r.status, r.json.error], [403, 'ban_evasion']);
    fs.store.set('users/fine', { ...game, email: 'fine@gmail.com', ingameName: 'Suraj' });
    assert.strictEqual((await s.call('POST', '/api/v2/me/check', { token: 'fine', body: { ingameName: 'Suraj', gameUid: '444444444' } })).status, 200);
    assert.strictEqual((await s.call('GET', '/api/v2/wallet', { token: 'fine' })).status, 200);
    r = await s.call('POST', '/api/v2/me/check', { token: 'fine', body: { ingameName: 'Suraj', gameUid: '333333333' } });
    assert.deepStrictEqual([r.status, r.json.error], [403, 'ban_evasion']);
  } finally { await s.stop(); }
});
