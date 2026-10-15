'use strict';

/**
 * Is this uid an owner/admin? Same truth as Firestor.rules isAdmin(): a document admins/{uid} exists.
 * ADMIN_UIDS (env) also counts, and is the only source when Firestore is off. Answers are cached for 60 seconds.
 */
function createAdminCheck({ db, adminUids, now = () => Date.now(), ttlMs = 60000 }) {
  const cache = new Map();
  return async function isAdmin(uid) {
    if (adminUids.has(uid)) return true;
    if (!db) return false;
    const hit = cache.get(uid);
    if (hit && now() - hit.at < ttlMs) return hit.v;
    const v = (await db.collection('admins').doc(uid).get()).exists;
    cache.set(uid, { v, at: now() });
    if (cache.size > 1000) cache.clear();
    return v;
  };
}

module.exports = { createAdminCheck };
