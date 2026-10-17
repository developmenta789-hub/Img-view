'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./config');
const { open } = require('./db');
const { HttpError, bad, forbidden } = require('./errors');
const { createVerifier, googleKeyFetcher } = require('./firebase-auth');
const wallet = require('./wallet');
const dep = require('./deposits');
const fsw = require('./fswallet');
const fsd = require('./fsdeposits');
const fsx = require('./fswithdrawals');
const fsm = require('./fsmatches');
const fsr = require('./fsresults');
const fsc = require('./fscancel');
const fsu = require('./fsusers');
const fsl = require('./fslang');
const fsp = require('./fspush');
const evasion = require('./fsevasion');
const { openFirestore, openMessaging, need } = require('./firestore');
const { createAdminCheck } = require('./admin');

const MAX_BODY = 600 * 1024;

/** Allows `max` hits per `windowMs` for one key (in memory; enough for a single small server). */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    return true;
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'too_large', 'Request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
        resolve(v);
      } catch (_) { reject(bad('bad_json', 'Request body must be a JSON object.')); }
    });
    req.on('error', reject);
  });
}

/**
 * Builds the HTTP server. `verifyToken(token)` -> { uid, name }: real Firebase check by default, replaceable in tests.
 * Routes: [method, path regex, auth ('none' | 'user' | 'admin'), handler(ctx)]. A handler returns a JSON object.
 */
function createApp({ config = load(), db = open(config.dbPath), verifyToken, fsdb = openFirestore() } = {}) {
  const isAdmin = createAdminCheck({ db: fsdb, adminUids: config.adminUids });
  const verify = verifyToken || createVerifier({ projectId: config.firebaseProjectId, getKey: googleKeyFetcher() });
  // Banned / suspended players are blocked on EVERY user route (wallet, deposit, withdraw, join, old SQLite routes), so removing the block screen in the app does not help.
  // Only /api/auth/session (login) stays open. Status is read from Firestore users/{uid} (cached 10 s, cleared when the owner changes a status).
  const blockCache = new Map();
  const toMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : 0);
  async function assertNotBlocked(uid, skipEvasion = false) {
    if (!fsdb) return;
    let c = blockCache.get(uid);
    if (!c || Date.now() - c.at > 10000) {
      const snap = await fsdb.collection('users').doc(uid).get();
      const u = snap.exists ? snap.data() : {};
      c = { at: Date.now(), status: u.status || 'active', until: toMs(u.suspendedUntil), evasion: snap.exists ? !!(await evasion.matchForUser(fsdb, uid, u)) : false };
      blockCache.set(uid, c);
      if (blockCache.size > 5000) blockCache.clear();
    }
    if (c.status === 'banned' || (c.status === 'suspended' && (!c.until || c.until > Date.now()))) {
      throw forbidden('blocked', c.status === 'banned' ? 'This account is banned.' : 'This account is suspended right now.');
    }
    if (c.evasion && !skipEvasion) throw evasion.evasionError(false);
  }
  const ipLimit = limiter(240, 60000);
  const depositLimit = limiter(10, 10 * 60000);
  const joinLimit = limiter(20, 60000);

  const routes = [
    ['GET', /^\/$/, 'none', () => ({ name: 'NST Server', ok: true })],
    ['GET', /^\/api\/health$/, 'none', () => ({ ok: true, time: Date.now() })],

    ['POST', /^\/api\/auth\/session$/, 'user', ({ user }) => {
      const name = (user.name || '').trim().slice(0, 100);
      db.prepare('INSERT INTO users (uid, name, created_at) VALUES (?,?,?) ON CONFLICT(uid) DO UPDATE SET name = CASE WHEN excluded.name != \'\' THEN excluded.name ELSE users.name END').run(user.uid, name, Date.now());
      return { uid: user.uid, isAdmin: config.adminUids.has(user.uid), ...wallet.getWallet(db, user.uid) };
    }],
    ['GET', /^\/api\/wallet$/, 'user', ({ user }) => wallet.getWallet(db, user.uid)],
    ['GET', /^\/api\/wallet\/history$/, 'user', ({ user, query }) => ({ items: wallet.history(db, user.uid, query.get('limit')) })],

    // Deposit screen in Payvex
    ['GET', /^\/api\/deposit\/config$/, 'user', ({ user }) => dep.depositConfig(db, config, user.uid)],
    ['GET', /^\/api\/payment-info$/, 'user', () => ({ paymentInfo: dep.getPaymentInfo(db) })],
    ['POST', /^\/api\/deposits$/, 'user', ({ user, body }) => {
      if (!depositLimit(user.uid)) throw new HttpError(429, 'slow_down', 'Too many requests. Try again in a few minutes.');
      return dep.createDeposit(db, config, user, body);
    }],
    ['GET', /^\/api\/deposits\/mine$/, 'user', ({ user, query }) => ({ items: dep.listMine(db, user.uid, query.get('limit')) })],

    // Owner (Admin app)
    ['GET', /^\/api\/admin\/deposits$/, 'admin', ({ query }) => ({ items: dep.adminList(db, query.get('status'), query.get('limit')) })],
    ['GET', /^\/api\/admin\/deposits\/([0-9a-f]{64})\/proof$/, 'admin', ({ m }) => dep.adminProof(db, m[1])],
    ['POST', /^\/api\/admin\/deposits\/([0-9a-f]{64})\/approve$/, 'admin', ({ m, user }) => dep.review(db, user.uid, m[1], true)],
    ['POST', /^\/api\/admin\/deposits\/([0-9a-f]{64})\/reject$/, 'admin', ({ m, user }) => dep.review(db, user.uid, m[1], false)],
    ['PUT', /^\/api\/admin\/payment-info$/, 'admin', ({ body }) => ({ paymentInfo: dep.setPaymentInfo(db, body) })],
    ['DELETE', /^\/api\/admin\/payment-info$/, 'admin', () => { dep.delSetting(db, 'paymentInfo'); return { ok: true }; }],
    ['PUT', /^\/api\/admin\/deposit-settings$/, 'admin', ({ body }) => { dep.setDepositSettings(db, body); return dep.depositConfig(db, config, ''); }],
    // v2: Firestore wallet (the same wallets/{uid} the apps read). Needs FIREBASE_SERVICE_ACCOUNT_B64.
    ['GET', /^\/api\/v2\/wallet$/, 'user', ({ user }) => fsw.getWallet(need(fsdb), user.uid)],
    ['GET', /^\/api\/v2\/wallet\/history$/, 'user', async ({ user, query }) => ({ items: await fsw.history(need(fsdb), user.uid, query.get('limit')) })],

    // v2 deposits on Firestore (Payvex Deposit screen + Admin Deposits / Payment details)
    ['GET', /^\/api\/v2\/deposit\/config$/, 'user', ({ user }) => fsd.depositConfig(need(fsdb), config, user.uid)],
    ['POST', /^\/api\/v2\/deposits$/, 'user', ({ user, body }) => {
      if (!depositLimit(user.uid)) throw new HttpError(429, 'slow_down', 'Too many requests. Try again in a few minutes.');
      return fsd.createDeposit(need(fsdb), config, user, body);
    }],
    ['GET', /^\/api\/v2\/deposits\/mine$/, 'user', async ({ user, query }) => ({ items: await fsd.listMine(need(fsdb), user.uid, query.get('limit')) })],
    ['GET', /^\/api\/v2\/admin\/deposits$/, 'admin', async ({ query }) => ({ items: await fsd.adminList(need(fsdb), query.get('status'), query.get('limit')) })],
    ['GET', /^\/api\/v2\/admin\/deposits\/([0-9a-f]{64})\/proof$/, 'admin', ({ m }) => fsd.adminProof(need(fsdb), m[1])],
    ['POST', /^\/api\/v2\/admin\/deposits\/([0-9a-f]{64})\/approve$/, 'admin', ({ m, user }) => fsd.review(need(fsdb), user.uid, m[1], true)],
    ['POST', /^\/api\/v2\/admin\/deposits\/([0-9a-f]{64})\/reject$/, 'admin', ({ m, user, body }) => fsd.review(need(fsdb), user.uid, m[1], false, body.reason)],
    ['PUT', /^\/api\/v2\/admin\/payment-info$/, 'admin', async ({ body }) => ({ paymentInfo: await fsd.setPaymentInfo(need(fsdb), body) })],
    ['DELETE', /^\/api\/v2\/admin\/payment-info$/, 'admin', () => fsd.deletePaymentInfo(need(fsdb))],
    ['PUT', /^\/api\/v2\/admin\/deposit-settings$/, 'admin', async ({ body }) => { await fsd.setDepositSettings(need(fsdb), body); return fsd.depositConfig(need(fsdb), config, ''); }],

    // v2 withdrawals on Firestore (only winnings can be withdrawn)
    ['GET', /^\/api\/v2\/withdraw\/config$/, 'user', ({ user }) => fsx.withdrawConfig(need(fsdb), user.uid)],
    ['POST', /^\/api\/v2\/withdrawals$/, 'user', ({ user, body }) => {
      if (!depositLimit(user.uid)) throw new HttpError(429, 'slow_down', 'Too many requests. Try again in a few minutes.');
      return fsx.createWithdrawal(need(fsdb), config, user, body);
    }],
    ['GET', /^\/api\/v2\/withdrawals\/mine$/, 'user', async ({ user, query }) => ({ items: await fsx.listMine(need(fsdb), user.uid, query.get('limit')) })],
    ['GET', /^\/api\/v2\/withdrawals\/([A-Za-z0-9_-]{1,60})\/proof$/, 'user', ({ m, user }) => fsx.proof(need(fsdb), m[1], user.uid, false)],
    ['GET', /^\/api\/v2\/admin\/withdrawals$/, 'admin', async ({ query }) => ({ items: await fsx.adminList(need(fsdb), query.get('status'), query.get('limit')) })],
    ['GET', /^\/api\/v2\/admin\/withdrawals\/([A-Za-z0-9_-]{1,60})\/proof$/, 'admin', ({ m, user }) => fsx.proof(need(fsdb), m[1], user.uid, true)],
    ['POST', /^\/api\/v2\/admin\/withdrawals\/([A-Za-z0-9_-]{1,60})\/approve$/, 'admin', ({ m, user, body }) => fsx.review(need(fsdb), config, user.uid, m[1], true, body)],
    ['POST', /^\/api\/v2\/admin\/withdrawals\/([A-Za-z0-9_-]{1,60})\/reject$/, 'admin', ({ m, user, body }) => fsx.review(need(fsdb), config, user.uid, m[1], false, body)],
    ['PUT', /^\/api\/v2\/admin\/withdraw-settings$/, 'admin', async ({ body }) => { await fsx.setWithdrawSettings(need(fsdb), body); return { ok: true }; }],

    // v2 match join on Firestore (fee + slot + registration in one transaction)
    ['POST', /^\/api\/v2\/tournaments\/([A-Za-z0-9_-]{1,60})\/join$/, 'user', ({ m, user, body }) => {
      if (!joinLimit(user.uid)) throw new HttpError(429, 'slow_down', 'Too many requests. Try again in a minute.');
      return fsm.joinTournament(need(fsdb), user, m[1], body);
    }],

    // v2 owner: result (prizes + kills + leaderboard), complete match, cancel + refund
    ['POST', /^\/api\/v2\/admin\/tournaments\/([A-Za-z0-9_-]{1,60})\/result$/, 'admin', async ({ m, body }) => {
      const out = await fsr.creditPrizes(need(fsdb), m[1], body.players);
      if (body.complete === true) out.completed = await fsr.completeMatch(need(fsdb), m[1]);
      return out;
    }],
    ['POST', /^\/api\/v2\/admin\/tournaments\/([A-Za-z0-9_-]{1,60})\/complete$/, 'admin', ({ m }) => fsr.completeMatch(need(fsdb), m[1])],
    ['POST', /^\/api\/v2\/admin\/tournaments\/([A-Za-z0-9_-]{1,60})\/cancel$/, 'admin', ({ m }) => fsc.cancelMatch(need(fsdb), m[1])],

    // v2 language (Arena website + Payvex): the server is the only writer of userLang/{uid}; both apps read it live from Firestore
    ['GET', /^\/api\/v2\/lang$/, 'user', ({ user }) => fsl.getLang(need(fsdb), user.uid)],
    ['POST', /^\/api\/v2\/lang$/, 'user', ({ user, body }) => fsl.setLang(need(fsdb), user.uid, body)],
    ['POST', /^\/api\/v2\/push\/register$/, 'user', ({ user, body }) => fsp.registerToken(need(fsdb), user.uid, body)],
    ['POST', /^\/api\/v2\/push\/unregister$/, 'user', ({ user, body }) => fsp.unregisterToken(need(fsdb), user.uid, body)],

    // v2 ban evasion: Arena calls this after signup and before saving game details ({ ingameName, gameUid } = the values about to be saved)
    ['POST', /^\/api\/v2\/me\/check$/, 'user', async ({ user, body }) => {
      const r = await evasion.checkIdentity(need(fsdb), user.uid, { ingameName: typeof body.ingameName === 'string' ? body.ingameName : '', gameUid: typeof body.gameUid === 'string' ? body.gameUid : '' });
      blockCache.delete(user.uid);
      if (!r.ok) throw evasion.evasionError(r.banned);
      return { ok: true };
    }],
    ['POST', /^\/api\/v2\/admin\/ban-locks\/rebuild$/, 'admin', () => evasion.rebuildLocks(need(fsdb))],

    // v2 owner: one player (status, game verify, activity, wallet edit)
    ['GET', /^\/api\/v2\/admin\/users\/([A-Za-z0-9_-]{1,128})$/, 'admin', ({ m }) => fsu.getUser(need(fsdb), m[1])],
    ['POST', /^\/api\/v2\/admin\/users\/([A-Za-z0-9_-]{1,128})\/status$/, 'admin', async ({ m, body }) => { const out = await fsu.setStatus(need(fsdb), m[1], body); blockCache.delete(m[1]); return out; }],
    ['POST', /^\/api\/v2\/admin\/users\/([A-Za-z0-9_-]{1,128})\/game-verified$/, 'admin', ({ m, body }) => fsu.setGameVerified(need(fsdb), m[1], body.value)],
    ['POST', /^\/api\/v2\/admin\/users\/([A-Za-z0-9_-]{1,128})\/activity$/, 'admin', ({ m, body }) => fsu.setActivity(need(fsdb), m[1], body)],
    ['POST', /^\/api\/v2\/admin\/users\/([A-Za-z0-9_-]{1,128})\/wallet$/, 'admin', ({ m, user, body }) => fsu.editWallet(need(fsdb), user.uid, m[1], body)],

    ['GET', /^\/api\/admin\/backup$/, 'admin', () => {
      const file = path.join(os.tmpdir(), 'nst-backup-' + process.pid + '-' + Date.now() + '.sqlite');
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const data = fs.readFileSync(file); fs.unlinkSync(file);
      return { raw: data, type: 'application/octet-stream' };
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (status, body, extra = {}) => {
      const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra };
      if (origin && config.corsOrigins.has(origin)) {
        headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      }
      if (body && body.raw) { res.writeHead(status, { ...headers, 'Content-Type': body.type }); res.end(body.raw); return; }
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS') return send(204, {});
      const url = new URL(req.url, 'http://x');
      const ip = req.socket.remoteAddress || '?';
      if (!ipLimit(ip + '|' + (req.headers['x-forwarded-for'] || ''))) throw new HttpError(429, 'slow_down', 'Too many requests.');
      let route; let m;
      for (const r of routes) { if (r[0] === req.method && (m = r[1].exec(url.pathname))) { route = r; break; } }
      if (!route) throw new HttpError(404, 'not_found', 'Not found.');
      let user = null;
      if (route[2] !== 'none') {
        const h = String(req.headers.authorization || '');
        if (!h.startsWith('Bearer ')) throw new HttpError(401, 'no_token', 'Please log in again.');
        user = await verify(h.slice(7));
        if (route[2] === 'admin' && !(await isAdmin(user.uid))) throw forbidden('not_admin', 'This account is not an admin on the server.');
        if (route[2] === 'user' && url.pathname !== '/api/auth/session') await assertNotBlocked(user.uid, url.pathname === '/api/v2/me/check');
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const out = await route[3]({ user, body, query: url.searchParams, m });
      send(200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.code, message: e.message });
      console.error('server error:', e && e.message);
      send(500, { error: 'server_error', message: 'Something went wrong on the server.' });
    }
  });
  return { server, db, config, fsdb };
}

if (require.main === module) {
  const { server, config, fsdb } = createApp();
  if (config.adminUids.size === 0) console.warn('WARNING: ADMIN_UIDS is empty, nobody can approve deposits.');
  server.listen(config.port, () => console.log('NST Server listening on port ' + config.port));
  if (fsdb && config.pushEnabled) {
    try { const msg = openMessaging(); fsp.startWatcher({ db: fsdb, messaging: msg, arenaUrl: config.arenaUrl }); fsp.startInviteWatcher({ db: fsdb, messaging: msg, arenaUrl: config.arenaUrl }); console.log('push: watching running matches and new slot invites'); }
    catch (e) { console.error('push is off: ' + (e && e.message)); }
  }
}

module.exports = { createApp };
