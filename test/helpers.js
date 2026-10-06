'use strict';
const crypto = require('node:crypto');
const { createApp } = require('../src/index');
const { load } = require('../src/config');
const { HttpError } = require('../src/errors');

/** Test login: token "uid" or "uid:Name". "bad" is rejected. */
async function fakeVerify(token) {
  if (token === 'bad') throw new HttpError(401, 'bad_token', 'Please log in again.');
  const [uid, name] = token.split(':');
  return { uid, name: name || '' };
}

async function start(env = {}) {
  const config = load({ ADMIN_UIDS: 'owner', DB_PATH: ':memory:', ...env });
  const app = createApp({ config, verifyToken: fakeVerify });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, path, { token, body, headers } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* binary */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { ...app, base, call, stop: () => new Promise((r) => { app.server.close(r); app.db.close(); }) };
}

/** A fake JPEG: starts with the JPEG marker, then random bytes (so every call is a different "screenshot"). */
function jpeg(size = 3000) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(size)]).toString('base64');
}
const shot = (amount = 100) => ({ amount, img: jpeg(3000), thumb: jpeg(500) });

module.exports = { start, jpeg, shot };
