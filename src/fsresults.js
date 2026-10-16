'use strict';
const { HttpError, bad, conflict } = require('./errors');
const { planCoins } = require('./fswallet');
const { weekKey } = require('./weekkey');

/**
 * Match result on Firestore: prize coins + result rows + leaderboard, and the "complete match" step.
 * Same documents the Admin app (MatchControlActivity) writes today, but coins move here, in one transaction per player:
 *   prizeCredits/{tid}_{uid}                 { uid, name, tournamentId, tournamentTitle?, amount, createdAt }   (only when coins >= 1)
 *   results/{tid}/players/{uid}              { uid, name, kills, winning, createdAt }
 *   wallets/{uid}                            coins + winCoins (prize is winnings; ledger prize_<tid>_<uid>)
 *   leaderboard/{uid}                        lifetime  { name, points, kills, wins }
 *   leaderboardWeeks/{week}/players/{uid}    this week { name, points, kills, wins }
 * A player can be saved only ONCE per match (the result row is create-only), so a retry never pays twice.
 * Limits the Admin app only warns about are enforced here: total coins <= prizePool, and (Battle Royale only) total kills <= joined - 1.
 * Clash Squad, Lone Wolf and Battle Royale Duo/Squad (revive) have no total kills limit (each row still 0..200); only Solo keeps joined - 1.
 * Complete match is a SEPARATE step: ongoing -> completed (+ the results/{tid} summary Arena shows).
 */
const TID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ITEMS = 200;
const PTS_PER_KILL = 5;
const PTS_PER_COIN = 1;
const isInt = Number.isSafeInteger;

/** Kills have no total limit in Clash Squad / Lone Wolf (rounds) and Battle Royale Duo / Squad (teammates are revived). Only Solo keeps kills <= joined - 1.
 *  Old matches without modeType: teamSize > 1, 1v1 (maxPlayers 2), or Clash/Class Squad / Lone Wolf in category or title. */
function isRoundMode(m) {
  if (m.modeType === 'Clash Squad' || m.modeType === 'Lone Wolf') return true;
  if (isInt(m.teamSize) && m.teamSize > 1) return true;
  if (isInt(m.teamSize) && m.teamSize === 1 && m.maxPlayers === 2) return true;
  if (m.modeType === 'Battle Royale') return false;
  return /clash|class sq|lone ?wolf/i.test(String(m.category || '') + ' ' + String(m.title || ''));
}

async function loadMatch(db, tid) {
  if (!TID_RE.test(String(tid))) throw bad('bad_id', 'Bad match id.');
  const s = await db.collection('tournaments').doc(tid).get();
  if (!s.exists) throw new HttpError(404, 'not_found', 'Match not found.');
  return s.data();
}

function cleanItems(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) throw bad('bad_players', 'Send 1 to ' + MAX_ITEMS + ' players.');
  const seen = new Set();
  return raw.map((x) => {
    if (!x || typeof x !== 'object' || !UID_RE.test(String(x.uid))) throw bad('bad_players', 'Every player needs a uid.');
    if (seen.has(x.uid)) throw bad('bad_players', 'Same player twice.');
    seen.add(x.uid);
    if (!isInt(x.kills) || x.kills < 0 || x.kills > 200) throw bad('bad_kills', 'Kills must be 0 to 200.');
    if (!isInt(x.coins) || x.coins < 0 || x.coins > 100000) throw bad('bad_coins', 'Coins must be 0 to 100000.');
    if (x.kills === 0 && x.coins === 0) throw bad('empty_row', 'A row with 0 kills and 0 coins is not saved.');
    return { uid: x.uid, kills: x.kills, coins: x.coins };
  });
}

/** Saves the prizes and kills of the given players. Players already saved are skipped (never paid twice). */
async function creditPrizes(db, tid, rawItems, now = () => new Date()) {
  const items = cleanItems(rawItems);
  const m = await loadMatch(db, tid);
  if (m.status === 'cancelled') throw conflict('cancelled', 'This match is cancelled.');
  if (m.status !== 'ongoing' && m.status !== 'completed') throw conflict('not_started', 'Start the match before saving the result.');
  const title = typeof m.title === 'string' ? m.title.slice(0, 80) : '';

  const rows = (await db.collection('results').doc(tid).collection('players').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const saved = new Set(rows.map((r) => r.id));
  const todo = items.filter((it) => !saved.has(it.uid));
  const skipped = items.filter((it) => saved.has(it.uid)).map((it) => it.uid);

  let coins = rows.reduce((a, r) => a + (isInt(r.winning) ? r.winning : 0), 0);
  let kills = rows.reduce((a, r) => a + (isInt(r.kills) ? r.kills : 0), 0);
  let top = rows.reduce((a, r) => Math.max(a, isInt(r.winning) ? r.winning : 0), 0);
  for (const it of todo) { coins += it.coins; kills += it.kills; top = Math.max(top, it.coins); }
  const pool = isInt(m.prizePool) ? m.prizePool : 0;
  const maxKills = Math.max((isInt(m.joined) ? m.joined : 0) - 1, 0);
  if (coins > pool) throw bad('over_pool', 'Total coins ' + coins + ' are more than the prize pool ' + pool + '.');
  const killsFree = isRoundMode(m);
  if (!killsFree && kills > maxKills) throw bad('too_many_kills', 'Total kills ' + kills + ' are more than possible (' + maxKills + ').');

  for (const it of todo) {
    const rs = await db.collection('registrations').doc(tid + '_' + it.uid).get();
    if (!rs.exists) throw bad('not_joined', 'Player ' + it.uid + ' did not join this match.');
    it.name = String(rs.data().name || 'Player').slice(0, 100);
    it.win = top > 0 && it.coins === top;
  }

  const week = weekKey(now().getTime());
  let credited = 0;
  let done = 0;
  for (const it of todo) {
    try {
      await db.runTransaction(async (t) => {
        const rref = db.collection('results').doc(tid).collection('players').doc(it.uid);
        const pref = db.collection('prizeCredits').doc(tid + '_' + it.uid);
        const lref = db.collection('leaderboard').doc(it.uid);
        const wref = db.collection('leaderboardWeeks').doc(week).collection('players').doc(it.uid);
        const rs = await t.get(rref);
        const ps = await t.get(pref);
        const ls = await t.get(lref);
        const ws = await t.get(wref);
        if (rs.exists || ps.exists) throw conflict('already_saved', 'Already saved.');
        const plan = it.coins >= 1
          ? await planCoins(t, db, { uid: it.uid, delta: it.coins, winDelta: it.coins, type: 'prize', ref: tid + '_' + it.uid, note: 'Prize: ' + title })
          : null;
        const at = now();
        if (plan) plan.write();
        if (it.coins >= 1) {
          const pc = { uid: it.uid, name: it.name, tournamentId: tid, amount: it.coins, createdAt: at };
          if (title) pc.tournamentTitle = title;
          t.create(pref, pc);
        }
        t.create(rref, { uid: it.uid, name: it.name, kills: it.kills, winning: it.coins, createdAt: at });
        const add = (s) => {
          const d = s.exists ? s.data() : {};
          const n = (v) => (isInt(v) ? v : 0);
          return { name: it.name.slice(0, 40), points: n(d.points) + it.coins * PTS_PER_COIN + it.kills * PTS_PER_KILL, kills: n(d.kills) + it.kills, wins: n(d.wins) + (it.win ? 1 : 0) };
        };
        t.set(lref, add(ls), { merge: true });
        t.set(wref, add(ws), { merge: true });
      });
      done += 1; credited += it.coins;
    } catch (e) {
      if (e instanceof HttpError && e.code === 'already_saved') { skipped.push(it.uid); continue; }
      const why = e instanceof HttpError ? e.message : 'Database error.';
      throw new HttpError(e instanceof HttpError ? e.status : 500, e instanceof HttpError ? e.code : 'partial_save',
        'Stopped at ' + it.name + ': ' + why + ' ' + done + ' player(s) before this one are saved. Send the same list again to continue.');
    }
  }
  return { saved: done, skipped, credited, totalCoins: coins, totalKills: kills, week };
}

/** ongoing -> completed. Also writes the results/{tid} summary Arena shows (place1..3, top killer), when there is none yet. */
async function completeMatch(db, tid, now = () => new Date()) {
  if (!TID_RE.test(String(tid))) throw bad('bad_id', 'Bad match id.');
  const tref = db.collection('tournaments').doc(tid);
  const sref = db.collection('results').doc(tid);
  return db.runTransaction(async (t) => {
    const ts = await t.get(tref);
    if (!ts.exists) throw new HttpError(404, 'not_found', 'Match not found.');
    const m = ts.data();
    if (m.status === 'cancelled') throw conflict('cancelled', 'This match is cancelled.');
    if (m.status === 'completed') throw conflict('already_completed', 'This match is already completed.');
    if (m.status !== 'ongoing') throw conflict('not_started', 'Start the match before completing it.');
    const ss = await t.get(sref);
    const ps = await t.get(sref.collection('players'));
    let summary = false;
    if (!ss.exists) {
      const rows = ps.docs.map((d) => d.data());
      const win = rows.filter((r) => isInt(r.winning) && r.winning > 0).sort((a, b) => b.winning - a.winning);
      if (win.length) {
        const s = { tournamentId: tid, publishedAt: now() };
        const title = typeof m.title === 'string' ? m.title.slice(0, 80) : '';
        if (title) s.tournamentTitle = title;
        ['place1', 'place2', 'place3'].forEach((k, i) => { if (win[i]) s[k] = String(win[i].name).slice(0, 40); });
        let tk = null;
        for (const r of rows) if (isInt(r.kills) && r.kills > 0 && (!tk || r.kills > tk.kills)) tk = r;
        if (tk) { s.topKiller = String(tk.name).slice(0, 40); s.topKills = tk.kills; }
        t.create(sref, s);
        summary = true;
      }
    }
    t.update(tref, { status: 'completed' });
    return { status: 'completed', summary };
  });
}

module.exports = { creditPrizes, completeMatch, isRoundMode };
