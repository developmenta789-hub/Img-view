'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const { start, shot } = require('./helpers');

test('banned and suspended players are blocked on every user route; active players and login still work', async () => {
  const fs = fakeFs();
  fs.store.set('users/ok', { ingameName: 'A' });
  fs.store.set('users/ban1', { status: 'banned' });
  fs.store.set('users/sus', { status: 'suspended', suspendedUntil: new Date(Date.now() + 3600000) });
  fs.store.set('users/over', { status: 'suspended', suspendedUntil: new Date(Date.now() - 3600000) });
  fs.store.set('admins/owner', {});
  const s = await start({}, fs);
  try {
    for (const token of ['ban1', 'sus']) {
      for (const [m, path, body] of [
        ['GET', '/api/v2/wallet'], ['GET', '/api/v2/wallet/history'], ['GET', '/api/v2/deposit/config'], ['GET', '/api/v2/withdraw/config'],
        ['POST', '/api/v2/deposits', shot(50)], ['POST', '/api/v2/withdrawals', { amount: 50, payout: 'a@upi' }], ['POST', '/api/v2/tournaments/t1/join', { slot: 1 }],
        ['GET', '/api/wallet'], ['GET', '/api/deposit/config'], ['POST', '/api/deposits', shot(50)],
      ]) {
        const r = await s.call(m, path, { token, body });
        assert.deepStrictEqual([r.status, r.json.error], [403, 'blocked'], token + ' ' + m + ' ' + path);
      }
    }
    assert.strictEqual((await s.call('POST', '/api/auth/session', { token: 'ban1', body: {} })).status, 200);
    assert.strictEqual((await s.call('GET', '/api/v2/wallet', { token: 'ok' })).status, 200);
    assert.strictEqual((await s.call('GET', '/api/v2/wallet', { token: 'over' })).status, 200);
    // owner bans a player: blocked at once (cache cleared), unban opens it again
    assert.strictEqual((await s.call('GET', '/api/v2/wallet', { token: 'ok' })).status, 200);
    const ban = await s.call('POST', '/api/v2/admin/users/ok/status', { token: 'owner', body: { status: 'banned', reason: 'cheating' } });
    assert.strictEqual(ban.status, 200);
    assert.strictEqual((await s.call('GET', '/api/v2/wallet', { token: 'ok' })).status, 403);
    await s.call('POST', '/api/v2/admin/users/ok/status', { token: 'owner', body: { status: 'active' } });
    assert.strictEqual((await s.call('GET', '/api/v2/wallet', { token: 'ok' })).status, 200);
  } finally { await s.stop(); }
});
