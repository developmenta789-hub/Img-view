'use strict';
const { HttpError } = require('./errors');

/**
 * Opens the Firestore database with the Firebase Admin SDK (the server may write; Security Rules do not apply to it).
 * Key: env FIREBASE_SERVICE_ACCOUNT_B64 (base64 of the JSON key, best for Render) or FIREBASE_SERVICE_ACCOUNT (raw JSON).
 * The key is NEVER stored in the repo or in the zip. The SDK is loaded only here, so tests and the old SQLite routes
 * work without it. Returns null when no key is set (the /api/v2 routes then answer 503 firestore_off).
 */
function openFirestore(env = process.env) {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    : env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw.trim()) return null;
  let key;
  try { key = JSON.parse(raw); } catch (_) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON'); }
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id });
  return admin.firestore();
}

/** FCM sender (Firebase Admin SDK). Call only after openFirestore() returned a handle, so the app is already initialised. */
function openMessaging() {
  return require('firebase-admin').messaging();
}

/** Route helper: the Firestore handle or a clear 503. */
function need(db) {
  if (!db) throw new HttpError(503, 'firestore_off', 'Server database is not configured yet.');
  return db;
}

module.exports = { openFirestore, openMessaging, need };
