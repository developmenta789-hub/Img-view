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
function createApp({ config = load(), db = open(config.dbPath), verifyToken } = {}) {
  const verify = verifyToken || createVerifier({ projectId: config.firebaseProjectId, getKey: googleKeyFetcher() });
  const ipLimit = limiter(240, 60000);
  const depositLimit = limiter(10, 10 * 60000);

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
        if (route[2] === 'admin' && !config.adminUids.has(user.uid)) throw forbidden('not_admin', 'This account is not an admin on the server.');
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
  return { server, db, config };
}

if (require.main === module) {
  const { server, config } = createApp();
  if (config.adminUids.size === 0) console.warn('WARNING: ADMIN_UIDS is empty, nobody can approve deposits.');
  server.listen(config.port, () => console.log('NST Server listening on port ' + config.port));
}

module.exports = { createApp };
