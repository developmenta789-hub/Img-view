'use strict';

/** All settings come from environment variables (see .env.example). Nothing secret is in the code. */
function load(env = process.env) {
  const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    port: int(env.PORT, 3000),
    dbPath: env.DB_PATH || './data/nst.sqlite',
    firebaseProjectId: env.FIREBASE_PROJECT_ID || 'noryvexal-784c8',
    adminUids: new Set(list(env.ADMIN_UIDS)),
    corsOrigins: new Set(list(env.CORS_ORIGINS)),
    depositMin: Math.max(1, int(env.DEPOSIT_MIN, 10)),
    depositMax: Math.max(1, int(env.DEPOSIT_MAX, 10000)),
    depositDailyLimit: Math.max(0, int(env.DEPOSIT_DAILY_LIMIT, 0)),
    depositMaxPending: Math.max(1, int(env.DEPOSIT_MAX_PENDING, 5)),
    tzOffsetMin: int(env.TZ_OFFSET_MIN, 330),
    maxImgBytes: 300 * 1024,
    maxThumbBytes: 40 * 1024,
  };
}

module.exports = { load };
