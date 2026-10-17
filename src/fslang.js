'use strict';
const { bad } = require('./errors');

/**
 * Player language (Arena website + Payvex), kept on the server so the two apps never fight over it.
 *   userLang/{uid} = { lang, version, updatedAt }   (players can only READ it; only this server writes it)
 * version goes up by 1 on every real change. The apps remember the last version they applied: a bigger version in Firestore
 * is a newer choice made somewhere else (apply it), the same or a smaller one is old news (ignore it). No phone clock is used.
 * lang = the website's language code: en, hi, zh-CN, iw ... (2 to 3 letters, optional region).
 */
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/;

async function getLang(db, uid) {
  const s = await db.collection('userLang').doc(uid).get();
  const d = s.exists ? s.data() : {};
  return { lang: typeof d.lang === 'string' ? d.lang : null, version: Number.isSafeInteger(d.version) ? d.version : 0 };
}

/** body: { lang }. Same language as saved = nothing changes (version stays). Returns { lang, version }. */
async function setLang(db, uid, body, now = () => new Date()) {
  const lang = body && typeof body.lang === 'string' ? body.lang.trim() : '';
  if (!LANG_RE.test(lang)) throw bad('bad_lang', 'Unknown language.');
  const ref = db.collection('userLang').doc(uid);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const d = s.exists ? s.data() : {};
    const version = Number.isSafeInteger(d.version) ? d.version : 0;
    if (s.exists && d.lang === lang) return { lang, version };
    t.set(ref, { lang, version: version + 1, updatedAt: now() });
    return { lang, version: version + 1 };
  });
}

module.exports = { getLang, setLang, LANG_RE };
