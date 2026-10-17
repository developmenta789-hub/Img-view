'use strict';
const { bad } = require('./errors');

/**
 * Web push (FCM) for the Arena website, free: FCM costs nothing and this server sends with the Firebase Admin SDK,
 * so no Cloud Functions (Blaze plan) are needed.
 *   pushTokens/{uid}   { tokens: [fcm token, ... max 5 newest], updatedAt }   only this server reads / writes it (clients have no rule)
 *   pushLog/{tid}_started   { at }   created ONCE per match, so a restart of the server never sends the same push twice
 * Today one push exists: "match started" to every player who joined (tournaments.status becomes ongoing / live).
 * The push text never contains the Room ID or password (a lock screen can be read by anyone); it only opens the match page.
 */
const MAX_TOKENS = 5;
const TOKEN_RE = /^[A-Za-z0-9:_-]{20,4096}$/;
const TID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const STALE_MS = 6 * 60 * 60 * 1000; // a match whose scheduled start is older than this is not announced (old matches left "ongoing")
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

const toMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : 0);
const cleanTokens = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && TOKEN_RE.test(x)) : []);

function tokenOf(body) {
  const t = body && typeof body.token === 'string' ? body.token.trim() : '';
  if (!TOKEN_RE.test(t)) throw bad('bad_token', 'Bad notification token.');
  return t;
}

/** body: { token }. The token goes to the END of the player's list (newest), the list keeps the last 5, and the same token is taken away
 *  from every other player (one browser = one player: after a log out / log in on a shared phone the old player stops getting pushes). */
async function registerToken(db, uid, body, now = () => new Date()) {
  const token = tokenOf(body);
  const others = (await db.collection('pushTokens').where('tokens', 'array-contains', token).get()).docs.filter((d) => d.id !== uid);
  for (const o of others) {
    await db.collection('pushTokens').doc(o.id).set({ tokens: cleanTokens(o.data().tokens).filter((x) => x !== token), updatedAt: now() }, { merge: true });
  }
  const ref = db.collection('pushTokens').doc(uid);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const list = cleanTokens(s.exists ? s.data().tokens : []).filter((x) => x !== token);
    list.push(token);
    const tokens = list.slice(-MAX_TOKENS);
    t.set(ref, { tokens, updatedAt: now() });
    return { ok: true, devices: tokens.length };
  });
}

async function unregisterToken(db, uid, body, now = () => new Date()) {
  const token = tokenOf(body);
  const ref = db.collection('pushTokens').doc(uid);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) return { ok: true, devices: 0 };
    const tokens = cleanTokens(s.data().tokens).filter((x) => x !== token);
    t.set(ref, { tokens, updatedAt: now() });
    return { ok: true, devices: tokens.length };
  });
}

/** Sends one notification to every saved token of `uids`. Dead tokens (uninstalled / expired) are removed from their owner. */
async function sendToUids(db, messaging, uids, { title, body, link, icon, tag, ttl = 3600 }) {
  const owner = new Map(); // token -> uid
  for (const uid of uids) {
    const s = await db.collection('pushTokens').doc(uid).get();
    if (s.exists) for (const t of cleanTokens(s.data().tokens)) owner.set(t, uid);
  }
  const all = [...owner.keys()];
  const out = { sent: 0, failed: 0, removed: 0, players: uids.length };
  for (let i = 0; i < all.length; i += 500) {
    const tokens = all.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      webpush: {
        headers: { Urgency: 'high', TTL: String(ttl) },
        notification: { ...(icon ? { icon } : {}), ...(tag ? { tag } : {}) },
        ...(link ? { fcmOptions: { link } } : {}),
      },
    });
    const dead = [];
    res.responses.forEach((r, k) => {
      if (r.success) { out.sent += 1; return; }
      out.failed += 1;
      const code = r.error && r.error.code;
      if (DEAD.has(code)) dead.push(tokens[k]);
    });
    for (const tk of dead) {
      const uid = owner.get(tk);
      const ref = db.collection('pushTokens').doc(uid);
      const s = await ref.get();
      if (s.exists) { await ref.set({ tokens: cleanTokens(s.data().tokens).filter((x) => x !== tk) }, { merge: true }); out.removed += 1; }
    }
  }
  return out;
}

/** Players who joined a match: registrations/{tid}_{uid} (every teammate and every invited friend has their own one). */
async function joinedUids(db, tid) {
  const docs = (await db.collection('registrations').where('tournamentId', '==', tid).get()).docs;
  const set = new Set();
  for (const d of docs) { const r = d.data(); if (typeof r.uid === 'string' && d.id === tid + '_' + r.uid) set.add(r.uid); }
  return [...set];
}

/** "Match started" push, at most ONCE per match. Returns { skipped } or the send counts. */
async function notifyMatchStarted(db, messaging, tid, { arenaUrl, now = () => new Date() } = {}) {
  if (!TID_RE.test(String(tid))) return { skipped: 'bad_id' };
  const tref = db.collection('tournaments').doc(tid);
  const ts = await tref.get();
  if (!ts.exists) return { skipped: 'no_match' };
  const m = ts.data();
  if (m.status !== 'ongoing' && m.status !== 'live') return { skipped: 'not_started' };
  const st = toMs(m.startTime);
  if (st && now().getTime() - st > STALE_MS) return { skipped: 'old_match' };

  const mark = db.collection('pushLog').doc(tid + '_started');
  try {
    await db.runTransaction(async (t) => { t.create(mark, { at: now() }); });
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message)))) return { skipped: 'already_sent' };
    throw e;
  }
  try {
    const uids = await joinedUids(db, tid);
    if (!uids.length) return { sent: 0, failed: 0, removed: 0, players: 0 };
    const title = typeof m.title === 'string' && m.title.trim() ? m.title.trim().slice(0, 80) : 'Your match';
    const base = String(arenaUrl || '').replace(/\/+$/, '');
    return await sendToUids(db, messaging, uids, {
      title: 'Match started!',
      body: title + ' has started. Open Noryvexal Arena now.',
      link: base ? base + '/home.html#/match/' + tid : undefined,
      icon: base ? base + '/assets/ic_launcher.png' : undefined,
      tag: 'match-' + tid,
    });
  } catch (e) {
    await mark.delete().catch(() => {}); // nothing was sent: let the next start of the server try again
    throw e;
  }
}

/**
 * "X invited you" push (2026-10-17): a player who is NOT on the website still sees the match invite on the lock screen. At most ONCE per invite
 * (pushLog/inv_{inviteId}_{createdAtMs}). Not sent for a self hold (fromUid == toUid / hold:true), for an invite older than its 5 minutes, or when the match is no longer upcoming.
 * The text never contains the Room ID; it opens the match page where the reserved seat is already ticked. TTL 5 min: a late push for a dead invite is useless.
 */
const INVITE_TTL_MS = 5 * 60 * 1000;   // SAME as fsmatches.js / Firestor.rules siExpired / Arena INVITE.ttlMin
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
async function notifyInvite(db, messaging, id, inv, { arenaUrl, now = () => new Date() } = {}) {
  if (!inv || typeof inv.toUid !== 'string' || typeof inv.fromUid !== 'string' || !TID_RE.test(String(inv.tournamentId))) return { skipped: 'bad_invite' };
  if (inv.fromUid === inv.toUid || inv.hold === true) return { skipped: 'self_hold' };
  const created = toMs(inv.createdAt);
  if (!created) return { skipped: 'no_time' };
  if (now().getTime() - created >= INVITE_TTL_MS) return { skipped: 'expired' };
  const ts = await db.collection('tournaments').doc(inv.tournamentId).get();
  if (!ts.exists || ts.data().status !== 'upcoming') return { skipped: 'not_upcoming' };
  const m = ts.data();
  const mark = db.collection('pushLog').doc('inv_' + id + '_' + created);
  try {
    await db.runTransaction(async (t) => { t.create(mark, { at: now() }); });
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message)))) return { skipped: 'already_sent' };
    throw e;
  }
  try {
    const base = String(arenaUrl || '').replace(/\/+$/, '');
    const from = clip(inv.fromName, 30) || 'A friend';
    const title = clip(m.title, 60) || 'a match';
    const slot = String(Number(inv.slot) || '').padStart(2, '0');
    return await sendToUids(db, messaging, [inv.toUid], {
      title: from + ' invited you to play',
      body: 'Join ' + title + ', slot ' + slot + '. Seat is held for 5 minutes.' + (inv.pay === true ? ' ' + from + ' pays your entry fee.' : ''),
      link: base ? base + '/home.html#/match/' + inv.tournamentId : undefined,
      icon: base ? base + '/assets/ic_launcher.png' : undefined,
      tag: 'invite-' + id,
      ttl: 300,
    });
  } catch (e) {
    await mark.delete().catch(() => {});
    throw e;
  }
}

/** Live watch on NEW slot invites (only those made after the watcher opened, so a restart never replays old ones). Cheap: a read only when an invite is created. Reconnects after 30 s. Returns stop(). */
function startInviteWatcher({ db, messaging, arenaUrl, now = () => new Date(), log = console, retryMs = 30000 }) {
  let unsub = null; let timer = null; let stopped = false;
  const seen = new Set();
  const handle = (doc) => {
    if (seen.has(doc.id + toMs(doc.data().createdAt))) return Promise.resolve();
    seen.add(doc.id + toMs(doc.data().createdAt));
    if (seen.size > 2000) seen.clear();
    return notifyInvite(db, messaging, doc.id, doc.data(), { arenaUrl, now })
      .then((r) => { if (r && r.sent !== undefined) log.log('push: invite ' + doc.id + ' sent ' + r.sent + ', failed ' + r.failed); })
      .catch((e) => log.error('invite push error for ' + doc.id + ': ' + (e && e.message)));
  };
  const open = () => {
    if (stopped) return;
    const since = new Date(now().getTime() - 2 * 60 * 1000);
    unsub = db.collection('slotInvites').where('createdAt', '>', since).onSnapshot(
      (snap) => { snap.docChanges().forEach((ch) => { if (ch.type === 'added') handle(ch.doc); }); },
      (err) => {
        log.error('invite watcher stopped: ' + (err && err.message) + ' (retry in ' + Math.round(retryMs / 1000) + ' s)');
        try { if (unsub) unsub(); } catch (_) { /* already closed */ }
        if (!stopped) timer = setTimeout(open, retryMs);
      },
    );
  };
  open();
  return () => { stopped = true; if (timer) clearTimeout(timer); try { if (unsub) unsub(); } catch (_) { /* already closed */ } };
}

/**
 * Live watch on the matches that are running (status ongoing / live). Firestore charges a read only when a document changes,
 * so this costs almost nothing on the free plan. Works with any client that starts a match (Admin app today).
 * Returns stop(). If the listener breaks it reconnects after 30 s.
 */
function startWatcher({ db, messaging, arenaUrl, now = () => new Date(), log = console, retryMs = 30000 }) {
  let unsub = null; let timer = null; let stopped = false;
  const seen = new Set(); // matches already handled by this running server (saves 2 reads each time a running match changes, e.g. a late join)
  const handle = (doc) => {
    if (seen.has(doc.id)) return Promise.resolve();
    seen.add(doc.id);
    if (seen.size > 2000) seen.clear();
    return notifyMatchStarted(db, messaging, doc.id, { arenaUrl, now })
      .then((r) => { if (r && r.sent !== undefined) log.log('push: match ' + doc.id + ' started, sent ' + r.sent + ', failed ' + r.failed + ', players ' + r.players); })
      .catch((e) => { seen.delete(doc.id); log.error('push error for match ' + doc.id + ': ' + (e && e.message)); });
  };
  const open = () => {
    if (stopped) return;
    unsub = db.collection('tournaments').where('status', 'in', ['ongoing', 'live']).onSnapshot(
      (snap) => { snap.docChanges().forEach((ch) => { if (ch.type === 'added' || ch.type === 'modified') handle(ch.doc); }); },
      (err) => {
        log.error('push watcher stopped: ' + (err && err.message) + ' (retry in ' + Math.round(retryMs / 1000) + ' s)');
        try { if (unsub) unsub(); } catch (_) { /* already closed */ }
        if (!stopped) timer = setTimeout(open, retryMs);
      },
    );
  };
  open();
  return () => { stopped = true; if (timer) clearTimeout(timer); try { if (unsub) unsub(); } catch (_) { /* already closed */ } };
}

module.exports = { registerToken, unregisterToken, sendToUids, notifyMatchStarted, startWatcher, notifyInvite, startInviteWatcher, joinedUids, MAX_TOKENS, TOKEN_RE };
