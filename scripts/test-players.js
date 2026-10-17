'use strict';
/**
 * TEST PLAYERS (2026-10-17). Makes fake players so you can test matches, teams, invites, friends, online status without 20 real phones.
 * Every fake player is marked isTest:true, so `cleanup` removes them (and their registrations / slots) again.
 *
 * !! Use a SEPARATE Firebase project for testing if you can. On the LIVE project these players show in Admin > Users, the leaderboard counts and "Players live".
 *
 * Key: same as the server: env FIREBASE_SERVICE_ACCOUNT_B64 (base64 of the service-account JSON) or FIREBASE_SERVICE_ACCOUNT. Never put the key in a zip / GitHub.
 *
 * Run from the "NST Server" folder (firebase-admin is already installed there):
 *   node scripts/test-players.js create 20            20 players: test01..test20  (login: testNN@example.com / Test@12345)
 *   node scripts/test-players.js join <matchId> 19    first 19 fake players join that match (first free slots; fee is taken from their fake wallet)
 *   node scripts/test-players.js friend <yourUid>     every fake player becomes a friend of you (for invite tests); also writes their "online" ping
 *   node scripts/test-players.js online 20 --keep     (add --keep: stays running, refreshes every 2 min, Ctrl+C to stop)
 *   node scripts/test-players.js online 10            first 10 fake players show as ONLINE now (others offline)
 *   node scripts/test-players.js list                 shows who exists
 *   node scripts/test-players.js cleanup              deletes ALL fake players + their registrations/slots/friends/presence
 * Options: --coins=500 (wallet of each new player), --prefix=test (name/email prefix)
 */
let admin = null;   // loaded in init(), so the help text works even before npm install

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : v]; }));
const pos = args.filter((a) => !a.startsWith('--'));
const cmd = pos[0];
const PREFIX = String(opt.prefix || 'test');
const COINS = Number(opt.coins || 500);
const PASSWORD = 'Test@12345';
const pad = (n) => String(n).padStart(2, '0');
const uidOf = (i) => `${PREFIX}player-${pad(i)}`;

function init() {
  admin = require('firebase-admin');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64 ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8') : process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw.trim()) { console.error('Set FIREBASE_SERVICE_ACCOUNT_B64 first (same key as the server).'); process.exit(1); }
  const key = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id });
  console.log('Project:', key.project_id);
  return { db: admin.firestore(), auth: admin.auth() };
}
const TS = () => admin.firestore.FieldValue.serverTimestamp();
const INC = (n) => admin.firestore.FieldValue.increment(n);

async function testUsers(db) {
  const snap = await db.collection('users').where('isTest', '==', true).get();
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => a.uid.localeCompare(b.uid));
}

async function create(db, auth, n) {
  for (let i = 1; i <= n; i++) {
    const uid = uidOf(i), email = `${PREFIX}${pad(i)}@example.com`, name = `Test Player ${pad(i)}`;
    try { await auth.getUser(uid); } catch (_) { await auth.createUser({ uid, email, password: PASSWORD, displayName: name, emailVerified: true }); }
    await db.collection('users').doc(uid).set({
      uid, name, email, age18Plus: true, createdAt: TS(), isTest: true,
      ingameName: `${PREFIX}Gamer${pad(i)}`, gameUid: String(8000000000 + i), gameLevel: 40 + (i * 7) % 50, gameVerified: true, status: 'active',
    }, { merge: true });
    await db.collection('wallets').doc(uid).set({ coins: COINS, winCoins: 0 }, { merge: true });
    console.log(`ok ${uid}  ${email}  game UID ${8000000000 + i}`);
  }
  console.log(`\nDone. Log in on the website with testNN@example.com / ${PASSWORD}`);
}

async function join(db, tid, n) {
  const users = (await testUsers(db)).slice(0, n);
  if (!users.length) return console.log('No test players. Run: create 20');
  const tref = db.collection('tournaments').doc(tid);
  let ok = 0;
  for (const u of users) {
    try {
      await db.runTransaction(async (t) => {
        const ts = await t.get(tref); if (!ts.exists) throw new Error('match not found');
        const m = ts.data();
        if (m.status !== 'upcoming') throw new Error('match is not upcoming');
        const max = Number(m.maxPlayers) || 0, joined = Number(m.joined) || 0;
        if (joined >= max) throw new Error('match full');
        const rref = db.collection('registrations').doc(`${tid}_${u.uid}`), wref = db.collection('wallets').doc(u.uid);
        const rs = await t.get(rref); if (rs.exists) return;   // already joined
        const slotSnaps = await t.get(tref.collection('slots'));
        const taken = new Set(slotSnaps.docs.map((d) => Number(d.id)));
        let slot = 0; for (let s = 1; s <= max; s++) if (!taken.has(s)) { slot = s; break; }
        if (!slot) throw new Error('no free slot');
        const fee = Number.isSafeInteger(m.entryFee) && m.entryFee > 0 ? m.entryFee : 0;
        const ws = await t.get(wref); const coins = ws.exists ? Number(ws.data().coins) || 0 : 0;
        if (fee > coins) throw new Error('fake wallet too small (use --coins= when creating)');
        if (fee > 0) t.update(wref, { coins: coins - fee });
        t.create(rref, { tournamentId: tid, uid: u.uid, name: u.ingameName, fee, slot, createdAt: new Date(), isTest: true });
        t.create(tref.collection('slots').doc(String(slot)), { uid: u.uid, name: u.ingameName, createdAt: new Date() });
        t.update(tref, { joined: joined + 1 });
      });
      ok++; console.log('joined', u.uid);
    } catch (e) { console.log('skip', u.uid, '-', e.message); if (/full|no free/.test(e.message)) break; }
  }
  console.log(`${ok} fake players joined ${tid}`);
}

async function friend(db, me) {
  const users = await testUsers(db), name = ((await db.collection('users').doc(me).get()).data() || {}).ingameName || 'Player';
  for (const u of users) {
    const b = db.batch();
    b.set(db.collection('friends').doc(me).collection('list').doc(u.uid), { uid: u.uid, name: u.ingameName, addedAt: TS(), isTest: true });
    b.set(db.collection('friends').doc(u.uid).collection('list').doc(me), { uid: me, name, addedAt: TS(), isTest: true });
    await b.commit();
  }
  console.log(`${users.length} fake players are now friends of ${me}`);
}

async function online(db, n) {
  const users = await testUsers(db);
  for (let i = 0; i < users.length; i++) {
    if (i < n) await db.collection('presence').doc(users[i].uid).set({ lastSeen: TS(), isTest: true });
    else await db.collection('presence').doc(users[i].uid).delete().catch(() => {});
  }
  console.log(`first ${Math.min(n, users.length)} online (stays online ~5 min), rest offline`);
  if (opt.keep) {   // --keep: stay running and refresh every 2 minutes, so they look LIVE until you press Ctrl+C
    console.log('Keeping them online. Press Ctrl+C to stop (they go offline after ~5 min).');
    setInterval(async () => { for (let i = 0; i < Math.min(n, users.length); i++) await db.collection('presence').doc(users[i].uid).set({ lastSeen: TS(), isTest: true }).catch(() => {}); console.log(new Date().toLocaleTimeString(), 'refreshed'); }, 120000);
    await new Promise(() => {});
  }
}

async function cleanup(db, auth) {
  const users = await testUsers(db);
  const perMatch = {};
  for (const u of users) {
    const regs = await db.collection('registrations').where('uid', '==', u.uid).get();
    for (const r of regs.docs) {
      const d = r.data(); perMatch[d.tournamentId] = (perMatch[d.tournamentId] || 0) + 1;
      await db.collection('tournaments').doc(d.tournamentId).collection('slots').doc(String(d.slot)).delete().catch(() => {});
      await r.ref.delete();
    }
    const fl = await db.collection('friends').doc(u.uid).collection('list').get();
    for (const f of fl.docs) { await db.collection('friends').doc(f.id).collection('list').doc(u.uid).delete().catch(() => {}); await f.ref.delete(); }
    for (const col of ['presence', 'wallets', 'userFriendCode', 'userTeams', 'users']) await db.collection(col).doc(u.uid).delete().catch(() => {});
    await auth.deleteUser(u.uid).catch(() => {});
    console.log('removed', u.uid);
  }
  for (const [tid, n] of Object.entries(perMatch)) await db.collection('tournaments').doc(tid).update({ joined: INC(-n) }).catch(() => {});
  console.log(`${users.length} fake players removed. Match "joined" counters fixed for ${Object.keys(perMatch).length} match(es).`);
  console.log('Not removed: team docs, invites and holds they made (delete those matches / teams by hand if you tested them).');
}

(async () => {
  if (!cmd) return console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
  const { db, auth } = init();
  if (cmd === 'create') await create(db, auth, Math.min(Math.max(parseInt(pos[1] || '20', 10) || 20, 1), 60));
  else if (cmd === 'join') await join(db, pos[1], parseInt(pos[2] || '20', 10));
  else if (cmd === 'friend') await friend(db, pos[1]);
  else if (cmd === 'online') await online(db, parseInt(pos[1] || '10', 10));
  else if (cmd === 'list') (await testUsers(db)).forEach((u) => console.log(u.uid, u.email, u.ingameName, u.gameUid));
  else if (cmd === 'cleanup') await cleanup(db, auth);
  else console.log('Unknown command. Run without arguments for help.');
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
