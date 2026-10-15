'use strict';
const { forbidden } = require('./errors');

/**
 * Ban evasion: a suspended or banned player must not come back with a new account.
 * When the owner bans or suspends someone, banLocks/{uid} keeps their identity: emailKey, gameUid, nickKey, until (ms, suspended only).
 * A new account is "the same person" when ANY of these matches another locked account:
 *   - e-mail  (normalised: lower case; Gmail dots and +tags removed)
 *   - game UID (exact)
 *   - game nickname that is the same or only a little different (Free Fire does not allow two equal names, so evaders add a letter or symbol)
 * Result: signup / game details are refused (new profile is deleted), every server route stays closed for that account,
 * and after STRIKES refused tries with the same e-mail the account itself is banned (and locked too).
 */
const STRIKES = 3;
const CACHE_MS = 60000;
const isInt = Number.isSafeInteger;

// Look-alike letters / digits / symbols and Cyrillic + Greek twins, so a changed spelling still gives the same key.
const MAP = { 0: 'o', 1: 'l', '!': 'l', '|': 'l', i: 'l', 3: 'e', 4: 'a', '@': 'a', 5: 's', $: 's', 7: 't', 8: 'b', 9: 'g',
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y', '\u0456': 'l', '\u043a': 'k', '\u043d': 'h', '\u0442': 't', '\u043c': 'm', '\u0432': 'b',
  '\u03bf': 'o', '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'l', '\u03ba': 'k', '\u03bd': 'v', '\u03c1': 'p', '\u03c4': 't', '\u03c7': 'x' };
/** Base key: fancy fonts (NFKD), accents, case, look-alikes; symbols, spaces and invisible characters removed. */
function nickKey(s, mapDigits = true) {
  const x = String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return [...x].map((c) => (!mapDigits && /[0-9!|@$]/.test(c) ? (/[0-9]/.test(c) ? c : '') : MAP[c] || c)).join('').replace(/[^a-z0-9\u0900-\u097f]/g, '');
}
/** Loose key: repeated letters collapsed, sound-alikes (c/q = k, ph = f), digits at both ends cut (KingX07, 007KingX). */
function looseKey(k) {
  return k.replace(/ph/g, 'f').replace(/[cq]/g, 'k').replace(/(.)\1+/g, '$1').replace(/^[0-9]+/, '').replace(/[0-9]+$/, '');
}
function emailKey(e) {
  const v = String(e || '').trim().toLowerCase();
  const at = v.lastIndexOf('@');
  if (at < 1) return '';
  let local = v.slice(0, at).split('+')[0];
  let domain = v.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local && domain ? local + '@' + domain : '';
}
/** Edit distance where one swap of two neighbouring letters counts as 1. */
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
/**
 * Same name, or the same name with small changes (any kind): other symbols or spaces, case, look-alike letters, fancy fonts,
 * doubled letters, numbers or a clan tag added at the start or end, one letter more / less / swapped, missing vowels.
 * Names shorter than 4 letters must be equal. Allowed edits grow with the length: 4-7 letters 1, 8-11 letters 2, 12-15 letters 3 ...
 */
function nickSimilar(a, b) {
  const ka = typeof a === 'string' ? nickKey(a) : '';
  const kb = typeof b === 'string' ? nickKey(b) : '';
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // once with digits read as look-alike letters (L3g3nd = Legend), once with digits kept so numbers at the ends can be cut (KingX07)
  return closeKeys(looseKey(ka), looseKey(kb)) || closeKeys(looseKey(nickKey(a, false)), looseKey(nickKey(b, false)));
}
function closeKeys(la, lb) {
  if (!la || !lb) return false;
  if (la === lb) return true;
  if (Math.min(la.length, lb.length) < 4) return false;
  if ([...la].reverse().join('') === lb) return true;
  const va = la.replace(/[aeiou]/g, ''), vb = lb.replace(/[aeiou]/g, '');
  if (va.length >= 4 && va === vb) return true;
  if (Math.min(la.length, lb.length) >= 5 && (la.includes(lb) || lb.includes(la))) return true;
  return lev(la, lb) <= Math.max(1, Math.floor(Math.max(la.length, lb.length) / 4));
}
const safeId = (s) => String(s).replace(/[^a-z0-9@._-]/g, '_').slice(0, 150);
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : isInt(v) ? v : 0);

/** The lock document for a banned / suspended player (u = users/{uid} data). */
function lockDoc(uid, u, status, until, reason, now = () => new Date()) {
  const d = { uid, status, emailKey: emailKey(u.email), gameUid: typeof u.gameUid === 'string' ? u.gameUid : '', nick: typeof u.ingameName === 'string' ? u.ingameName.slice(0, 40) : '', createdAt: now() };
  d.nickKey = nickKey(d.nick);
  if (until) d.until = until.getTime();
  if (reason) d.reason = String(reason).slice(0, 200);
  return d;
}

const caches = new WeakMap();
const rebuilt = new WeakSet();
async function loadLocks(db, nowMs = Date.now()) {
  const c = caches.get(db);
  if (c && nowMs - c.at < CACHE_MS) return c.list;
  let snap = await db.collection('banLocks').get();
  if (snap.empty !== false && snap.docs.length === 0 && !rebuilt.has(db)) {
    // first use after this feature was added: lock the players who were banned / suspended before it existed (once per server start)
    rebuilt.add(db);
    await rebuildLocks(db, () => new Date(nowMs));
    snap = await db.collection('banLocks').get();
  }
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  caches.set(db, { at: nowMs, list });
  return list;
}
const clearLocks = (db) => caches.delete(db);

/** id = { uid, email, gameUid, nick }. First lock that matches (not the same uid, suspension not over) -> { by, lock } else null. */
function findMatch(locks, id, nowMs = Date.now()) {
  const ek = emailKey(id.email);
  for (const l of locks) {
    if (l.uid === id.uid) continue;
    if (l.status === 'suspended' && isInt(l.until) && l.until <= nowMs) continue;
    if (ek && l.emailKey && l.emailKey === ek) return { by: 'email', lock: l };
    if (id.gameUid && l.gameUid && String(l.gameUid) === String(id.gameUid)) return { by: 'game_uid', lock: l };
    if (id.nick && l.nick && nickSimilar(id.nick, l.nick)) return { by: 'nickname', lock: l };
  }
  return null;
}

/** Match for a users/{uid} document (used on every guarded request, no writes). */
async function matchForUser(db, uid, u, nowMs = Date.now()) {
  return findMatch(await loadLocks(db, nowMs), { uid, email: u.email, gameUid: u.gameUid, nick: u.ingameName }, nowMs);
}

/**
 * Explicit check at signup / before saving game details. proposed = { ingameName, gameUid } (optional, the values about to be saved).
 * No match -> { ok: true }. Match -> counts a strike for this e-mail; new profile is deleted; at STRIKES the account is banned.
 */
async function checkIdentity(db, uid, proposed = {}, now = () => new Date()) {
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const u = snap.exists ? snap.data() : {};
  const nowMs = now().getTime();
  const locks = await loadLocks(db, nowMs);
  const id = { uid, email: u.email, gameUid: proposed.gameUid || u.gameUid, nick: proposed.ingameName || u.ingameName };
  const m = findMatch(locks, id, nowMs);
  if (!m) return { ok: true };
  const sref = db.collection('evasionStrikes').doc(safeId(emailKey(u.email) || uid));
  const ss = await sref.get();
  const count = (ss.exists && isInt(ss.data().count) ? ss.data().count : 0) + 1;
  await sref.set({ uid, count, by: m.by, lockUid: m.lock.uid, lastAt: now() });
  if (count >= STRIKES) {
    const reason = 'Ban evasion: same ' + (m.by === 'game_uid' ? 'game UID' : m.by === 'nickname' ? 'game nickname' : 'e-mail') + ' as a banned or suspended account.';
    const next = { uid, name: u.name || 'Player', email: u.email || '', age18Plus: true, ...u, status: 'banned', statusReason: reason };
    delete next.suspendedUntil;
    await ref.set(next);
    await db.collection('banLocks').doc(uid).set(lockDoc(uid, next, 'banned', null, reason, now));
    clearLocks(db);
    return { ok: false, by: m.by, strikes: count, banned: true };
  }
  if (snap.exists && !u.ingameName && !u.gameUid) await ref.delete(); // a brand-new signup: the profile is not created
  return { ok: false, by: m.by, strikes: count, banned: false };
}

/** Writes banLocks for every user who is banned or suspended now (for players banned before this feature existed). */
async function rebuildLocks(db, now = () => new Date()) {
  let n = 0;
  for (const status of ['banned', 'suspended']) {
    const snap = await db.collection('users').where('status', '==', status).limit(1000).get();
    for (const d of snap.docs) {
      const u = d.data();
      const until = status === 'suspended' && ms(u.suspendedUntil) ? new Date(ms(u.suspendedUntil)) : null;
      await db.collection('banLocks').doc(d.id).set(lockDoc(d.id, u, status, until, u.statusReason, now));
      n += 1;
    }
  }
  clearLocks(db);
  return { locks: n };
}

const evasionError = (banned) => forbidden('ban_evasion', banned
  ? 'This account is banned because it matches a banned or suspended account.'
  : 'These details match a banned or suspended account, so this account cannot be created or used. If you try again, this account will be banned.');

module.exports = { STRIKES, nickKey, emailKey, nickSimilar, lockDoc, loadLocks, clearLocks, findMatch, matchForUser, checkIdentity, rebuildLocks, evasionError };
