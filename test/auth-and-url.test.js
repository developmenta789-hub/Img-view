'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createVerifier } = require('../src/firebase-auth');
const { publicBaseUrl } = require('../src/publicurl');
const { start } = require('./helpers');

const PROJECT = 'noryvexal-784c8';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (b) => Buffer.from(b).toString('base64url');

function token({ kid = 'k1', alg = 'RS256', key = privateKey, claims = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, sub: 'user123', iat: now - 10, exp: now + 3600, name: 'Asha', ...claims };
  const head = b64u(JSON.stringify({ alg, kid, typ: 'JWT' })) + '.' + b64u(JSON.stringify(payload));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(head), key);
  return head + '.' + b64u(sig);
}
const verify = createVerifier({ projectId: PROJECT, getKey: async (kid) => (kid === 'k1' ? publicKey : null) });
const code = async (t) => { try { await verify(t); return 'ok'; } catch (e) { return e.code; } };

test('Firebase token: valid token gives uid and name', async () => {
  const u = await verify(token());
  assert.equal(u.uid, 'user123'); assert.equal(u.name, 'Asha');
});

test('Firebase token: every kind of bad token is refused', async () => {
  assert.equal(await code(token({ claims: { exp: Math.floor(Date.now() / 1000) - 3600 } })), 'token_expired');
  assert.equal(await code(token({ claims: { aud: 'other-project' } })), 'bad_token');
  assert.equal(await code(token({ claims: { iss: 'https://securetoken.google.com/other' } })), 'bad_token');
  assert.equal(await code(token({ claims: { sub: '' } })), 'bad_token');
  assert.equal(await code(token({ claims: { iat: Math.floor(Date.now() / 1000) + 3600 } })), 'bad_token');
  assert.equal(await code(token({ key: other.privateKey })), 'bad_token');      // signed by someone else
  assert.equal(await code(token({ kid: 'unknown' })), 'bad_token');
  assert.equal(await code(token({ alg: 'none' })), 'bad_token');
  assert.equal(await code('abc.def'), 'bad_token');
  assert.equal(await code(''), 'bad_token');
  const t = token().split('.'); t[1] = b64u(JSON.stringify({ sub: 'admin', aud: PROJECT, iss: 'https://securetoken.google.com/' + PROJECT, iat: 1, exp: 9999999999 }));
  assert.equal(await code(t.join('.')), 'bad_token');                            // payload swapped, signature no longer fits
});

test('public address: PUBLIC_URL wins, else Codespaces address, else empty', () => {
  assert.equal(publicBaseUrl({ PUBLIC_URL: 'https://x.example.com/' }), 'https://x.example.com');
  assert.equal(publicBaseUrl({ CODESPACE_NAME: 'happy-cs-123', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev', PORT: '3000' }), 'https://happy-cs-123-3000.app.github.dev');
  assert.equal(publicBaseUrl({}), '');
});

test('CORS: only listed web origins get headers', async () => {
  const s = await start({ CORS_ORIGINS: 'https://arena.example.com' });
  try {
    const ok = await s.call('GET', '/api/health', { headers: { Origin: 'https://arena.example.com' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://arena.example.com');
    const no = await s.call('GET', '/api/health', { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(s.base + '/api/deposits', { method: 'OPTIONS', headers: { Origin: 'https://arena.example.com' } });
    assert.equal(pre.status, 204);
  } finally { await s.stop(); }
});

test('server.json in the repo is valid JSON with baseUrl', () => {
  const j = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.json'), 'utf8'));
  assert.equal(typeof j.baseUrl, 'string');
});
