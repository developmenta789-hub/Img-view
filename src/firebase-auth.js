'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const unauth = (code, msg) => new HttpError(401, code, msg || 'Please log in again.');
const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Checks a Firebase ID token WITHOUT any extra library or service-account key:
 * RS256 signature against Google's public certificates, then exp / iat / aud / iss / sub.
 * getKey(kid) must return a crypto public key (or null). Returns { uid, name, email }.
 */
function createVerifier({ projectId, getKey, now = () => Date.now() }) {
  return async function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw unauth('bad_token');
    let header; let payload;
    try {
      header = JSON.parse(b64url(parts[0]).toString('utf8'));
      payload = JSON.parse(b64url(parts[1]).toString('utf8'));
    } catch (_) { throw unauth('bad_token'); }
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw unauth('bad_token');
    const key = await getKey(header.kid);
    if (!key) throw unauth('bad_token');
    const okSig = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, b64url(parts[2]));
    if (!okSig) throw unauth('bad_token');
    const t = Math.floor(now() / 1000);
    const leeway = 60;
    if (!payload || typeof payload.exp !== 'number' || payload.exp + leeway < t) throw unauth('token_expired', 'Login expired. Please log in again.');
    if (typeof payload.iat !== 'number' || payload.iat - leeway > t) throw unauth('bad_token');
    if (payload.aud !== projectId || payload.iss !== 'https://securetoken.google.com/' + projectId) throw unauth('bad_token');
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw unauth('bad_token');
    return { uid: payload.sub, name: typeof payload.name === 'string' ? payload.name : '', email: typeof payload.email === 'string' ? payload.email : '' };
  };
}

/** Downloads Google's signing certificates and keeps them until Cache-Control says they expire. */
function googleKeyFetcher(fetchFn = globalThis.fetch) {
  let keys = {}; let expires = 0; let loading = null;
  async function refresh() {
    const res = await fetchFn(CERT_URL);
    if (!res.ok) throw new Error('cert fetch ' + res.status);
    const certs = await res.json();
    const next = {};
    for (const [kid, pem] of Object.entries(certs)) next[kid] = crypto.createPublicKey(pem);
    const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
    keys = next; expires = Date.now() + (m ? Number(m[1]) : 3600) * 1000;
  }
  return async function getKey(kid) {
    if (Date.now() >= expires || !keys[kid]) {
      if (!loading) loading = refresh().finally(() => { loading = null; });
      try { await loading; } catch (e) { if (!keys[kid]) throw new HttpError(503, 'auth_unavailable', 'Could not check your login. Try again.'); }
    }
    return keys[kid] || null;
  };
}

module.exports = { createVerifier, googleKeyFetcher };
