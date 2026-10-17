'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const fsp = require('../src/fspush');

const code = (c) => (e) => e.code === c;
const tk = (n) => 'token_' + String(n).padStart(24, '0');
const ARENA = 'https://example.github.io/Noryvexal-Arena/';
const T0 = new Date('2026-10-17T10:00:00Z');

/** Fake FCM: remembers every multicast and can mark chosen tokens as dead. */
function fakeMessaging(dead = []) {
  const calls = [];
  return {
    calls,
    async sendEachForMulticast(msg) {
      calls.push(msg);
      return { responses: msg.tokens.map((t) => (dead.includes(t) ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true })) };
    },
  };
}

async function seedMatch(fs, { status = 'ongoing', start = T0, players = ['u1', 'u2'] } = {}) {
  await fs.collection('tournaments').doc('t1').set({ title: 'Squad Rush', status, startTime: start });
  for (const u of players) await fs.collection('registrations').doc('t1_' + u).set({ tournamentId: 't1', uid: u });
  await fs.collection('registrations').doc('t2_u9').set({ tournamentId: 't2', uid: 'u9' });
}

test('register keeps the newest 5 tokens, no duplicates, bad tokens refused', async () => {
  const fs = fakeFs();
  for (const bad of ['', 'short', 'has space ' + tk(1), '<script>' + tk(1), 5, null, undefined]) {
    await assert.rejects(fsp.registerToken(fs, 'u1', { token: bad }), code('bad_token'));
  }
  await assert.rejects(fsp.registerToken(fs, 'u1', null), code('bad_token'));
  for (let i = 1; i <= 6; i++) await fsp.registerToken(fs, 'u1', { token: tk(i) });
  assert.deepStrictEqual(fs.store.get('pushTokens/u1').tokens, [tk(2), tk(3), tk(4), tk(5), tk(6)]);
  const r = await fsp.registerToken(fs, 'u1', { token: tk(3) });
  assert.strictEqual(r.devices, 5);
  assert.deepStrictEqual(fs.store.get('pushTokens/u1').tokens, [tk(2), tk(4), tk(5), tk(6), tk(3)]);
});

test('a token belongs to one player: a new login on the same browser takes it from the old player', async () => {
  const fs = fakeFs();
  await fsp.registerToken(fs, 'u1', { token: tk(1) });
  await fsp.registerToken(fs, 'u1', { token: tk(2) });
  await fsp.registerToken(fs, 'u2', { token: tk(1) });
  assert.deepStrictEqual(fs.store.get('pushTokens/u1').tokens, [tk(2)]);
  assert.deepStrictEqual(fs.store.get('pushTokens/u2').tokens, [tk(1)]);
});

test('unregister removes only that token', async () => {
  const fs = fakeFs();
  assert.deepStrictEqual(await fsp.unregisterToken(fs, 'u1', { token: tk(1) }), { ok: true, devices: 0 });
  await fsp.registerToken(fs, 'u1', { token: tk(1) });
  await fsp.registerToken(fs, 'u1', { token: tk(2) });
  assert.deepStrictEqual(await fsp.unregisterToken(fs, 'u1', { token: tk(1) }), { ok: true, devices: 1 });
  assert.deepStrictEqual(fs.store.get('pushTokens/u1').tokens, [tk(2)]);
});

test('match started: only players who joined that match are notified, text has no room details', async () => {
  const fs = fakeFs(); const ms = fakeMessaging();
  await seedMatch(fs);
  await fs.collection('rooms').doc('t1').set({ roomId: '987654', roomPassword: 'secretpw' });
  await fsp.registerToken(fs, 'u1', { token: tk(1) });
  await fsp.registerToken(fs, 'u1', { token: tk(2) });
  await fsp.registerToken(fs, 'u2', { token: tk(3) });
  await fsp.registerToken(fs, 'u9', { token: tk(9) }); // joined another match
  await fsp.registerToken(fs, 'u7', { token: tk(7) }); // joined nothing
  const r = await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 });
  assert.deepStrictEqual([r.sent, r.failed, r.players], [3, 0, 2]);
  assert.strictEqual(ms.calls.length, 1);
  assert.deepStrictEqual([...ms.calls[0].tokens].sort(), [tk(1), tk(2), tk(3)]);
  const m = ms.calls[0];
  assert.strictEqual(m.notification.title, 'Match started!');
  assert.ok(m.notification.body.includes('Squad Rush'));
  assert.ok(!JSON.stringify(m).includes('987654') && !JSON.stringify(m).includes('secretpw'));
  assert.strictEqual(m.webpush.fcmOptions.link, 'https://example.github.io/Noryvexal-Arena/home.html#/match/t1');
});

test('the same match is announced only once, even if the server restarts and sees it again', async () => {
  const fs = fakeFs(); const ms = fakeMessaging();
  await seedMatch(fs);
  await fsp.registerToken(fs, 'u1', { token: tk(1) });
  assert.strictEqual((await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 })).sent, 1);
  assert.deepStrictEqual(await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 }), { skipped: 'already_sent' });
  assert.strictEqual(ms.calls.length, 1);
});

test('nothing is sent for an upcoming / cancelled / unknown / very old match', async () => {
  const ms = fakeMessaging();
  for (const status of ['upcoming', 'cancelled', 'completed']) {
    const fs = fakeFs(); await seedMatch(fs, { status }); await fsp.registerToken(fs, 'u1', { token: tk(1) });
    assert.deepStrictEqual(await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 }), { skipped: 'not_started' });
  }
  const fs = fakeFs(); await seedMatch(fs, { start: new Date(T0.getTime() - 7 * 3600 * 1000) }); await fsp.registerToken(fs, 'u1', { token: tk(1) });
  assert.deepStrictEqual(await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 }), { skipped: 'old_match' });
  assert.deepStrictEqual(await fsp.notifyMatchStarted(fs, ms, 'nope', { arenaUrl: ARENA, now: () => T0 }), { skipped: 'no_match' });
  assert.deepStrictEqual(await fsp.notifyMatchStarted(fs, ms, '../x', { arenaUrl: ARENA, now: () => T0 }), { skipped: 'bad_id' });
  assert.strictEqual(ms.calls.length, 0);
  assert.ok(!fs.store.has('pushLog/t1_started'));
});

test('a match with no player tokens sends nothing but is still marked done', async () => {
  const fs = fakeFs(); const ms = fakeMessaging();
  await seedMatch(fs);
  const r = await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 });
  assert.deepStrictEqual([r.sent, r.failed], [0, 0]);
  assert.strictEqual(ms.calls.length, 0);
  assert.ok(fs.store.has('pushLog/t1_started'));
});

test('dead tokens are removed from their owner, good ones stay', async () => {
  const fs = fakeFs(); const ms = fakeMessaging([tk(2)]);
  await seedMatch(fs);
  await fsp.registerToken(fs, 'u1', { token: tk(1) });
  await fsp.registerToken(fs, 'u1', { token: tk(2) });
  const r = await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 });
  assert.deepStrictEqual([r.sent, r.failed, r.removed], [1, 1, 1]);
  assert.deepStrictEqual(fs.store.get('pushTokens/u1').tokens, [tk(1)]);
});

test('if FCM itself fails the mark is removed so the next start of the server tries again', async () => {
  const fs = fakeFs();
  await seedMatch(fs);
  await fsp.registerToken(fs, 'u1', { token: tk(1) });
  const broken = { async sendEachForMulticast() { throw new Error('fcm down'); } };
  await assert.rejects(fsp.notifyMatchStarted(fs, broken, 't1', { arenaUrl: ARENA, now: () => T0 }), /fcm down/);
  assert.ok(!fs.store.has('pushLog/t1_started'));
  const ms = fakeMessaging();
  assert.strictEqual((await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 })).sent, 1);
});

test('more than 500 tokens are sent in chunks of 500', async () => {
  const fs = fakeFs(); const ms = fakeMessaging();
  const players = Array.from({ length: 260 }, (_, i) => 'p' + i);
  await seedMatch(fs, { players });
  for (let i = 0; i < 260; i++) {
    await fsp.registerToken(fs, 'p' + i, { token: tk(i * 2) });
    await fsp.registerToken(fs, 'p' + i, { token: tk(i * 2 + 1) });
  }
  const r = await fsp.notifyMatchStarted(fs, ms, 't1', { arenaUrl: ARENA, now: () => T0 });
  assert.strictEqual(r.sent, 520);
  assert.deepStrictEqual(ms.calls.map((c) => c.tokens.length), [500, 20]);
});

test('watcher: announces a match when it turns ongoing, ignores removed, and does not repeat', async () => {
  const fs = fakeFs(); const ms = fakeMessaging();
  await seedMatch(fs);
  await fsp.registerToken(fs, 'u1', { token: tk(1) });
  let push = null; let closed = false;
  const db = Object.assign(Object.create(fs), {
    collection: (n) => {
      const c = fs.collection(n);
      if (n !== 'tournaments') return c;
      return { ...c, where: (f, op, v) => ({ ...c.where(f, op, v), onSnapshot: (ok) => { push = ok; return () => { closed = true; }; } }) };
    },
  });
  const quiet = { log() {}, error() {} };
  const stop = fsp.startWatcher({ db, messaging: ms, arenaUrl: ARENA, now: () => T0, log: quiet });
  const doc = { id: 't1' };
  push({ docChanges: () => [{ type: 'removed', doc }] });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(ms.calls.length, 0);
  push({ docChanges: () => [{ type: 'added', doc }] });
  push({ docChanges: () => [{ type: 'modified', doc }] });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(ms.calls.length, 1);
  stop();
  assert.ok(closed);
});

test('HTTP: login needed, bad token 400, register then unregister', async () => {
  const { start } = require('./helpers');
  const fs = fakeFs();
  const s = await start({}, fs);
  try {
    assert.strictEqual((await s.call('POST', '/api/v2/push/register', { body: { token: tk(1) } })).status, 401);
    assert.strictEqual((await s.call('POST', '/api/v2/push/register', { token: 'u1', body: { token: 'bad!' } })).status, 400);
    const a = await s.call('POST', '/api/v2/push/register', { token: 'u1', body: { token: tk(1) } });
    assert.deepStrictEqual([a.status, a.json], [200, { ok: true, devices: 1 }]);
    assert.deepStrictEqual(fs.store.get('pushTokens/u1').tokens, [tk(1)]);
    const b = await s.call('POST', '/api/v2/push/unregister', { token: 'u1', body: { token: tk(1) } });
    assert.deepStrictEqual([b.status, b.json], [200, { ok: true, devices: 0 }]);
  } finally { await s.stop(); }
});

test('invite push: sent once to the invited player, never for a self hold / expired / started match', async () => {
  const fs = fakeFs(), m = fakeMessaging();
  await fs.collection('tournaments').doc('t1').set({ title: 'Squad Rush', status: 'upcoming', startTime: new Date(T0.getTime() + 3600000) });
  await fsp.registerToken(fs, 'u2', { token: tk(1) });
  const now = () => new Date(T0.getTime() + 60000);
  const inv = { tournamentId: 't1', slot: 5, fromUid: 'u1', fromName: 'Raj', toUid: 'u2', toName: 'Sam', createdAt: T0 };
  const r = await fsp.notifyInvite(fs, m, 't1_5', inv, { arenaUrl: ARENA, now });
  assert.strictEqual(r.sent, 1);
  assert.match(m.calls[0].notification.title, /Raj invited you/);
  assert.match(m.calls[0].notification.body, /Squad Rush, slot 05/);
  assert.doesNotMatch(m.calls[0].notification.body, /pays/);
  assert.strictEqual(m.calls[0].webpush.headers.TTL, '300');
  assert.strictEqual((await fsp.notifyInvite(fs, m, 't1_5', inv, { arenaUrl: ARENA, now })).skipped, 'already_sent');
  const paid = await fsp.notifyInvite(fs, m, 't1_6', { ...inv, slot: 6, pay: true }, { arenaUrl: ARENA, now });
  assert.strictEqual(paid.sent, 1);
  assert.match(m.calls[1].notification.body, /Raj pays your entry fee/);
  assert.strictEqual((await fsp.notifyInvite(fs, m, 't1_7', { ...inv, slot: 7, toUid: 'u1' }, { arenaUrl: ARENA, now })).skipped, 'self_hold');
  assert.strictEqual((await fsp.notifyInvite(fs, m, 't1_8', { ...inv, slot: 8, toUid: 'u2', hold: true }, { arenaUrl: ARENA, now })).skipped, 'self_hold');
  assert.strictEqual((await fsp.notifyInvite(fs, m, 't1_9', { ...inv, slot: 9 }, { arenaUrl: ARENA, now: () => new Date(T0.getTime() + 6 * 60000) })).skipped, 'expired');
  await fs.collection('tournaments').doc('t1').set({ title: 'Squad Rush', status: 'ongoing', startTime: T0 });
  assert.strictEqual((await fsp.notifyInvite(fs, m, 't1_10', { ...inv, slot: 10 }, { arenaUrl: ARENA, now })).skipped, 'not_upcoming');
  assert.strictEqual(m.calls.length, 2);
});
