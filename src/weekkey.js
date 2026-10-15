'use strict';

/**
 * Leaderboard week = Monday 00:00 to Sunday 23:59 India time (IST, UTC+5:30, no daylight saving).
 * The week is named by its Monday date, for example "2026-10-12".
 * Must stay identical to Admin Week.java and Arena weekKey() in js/firebase.js.
 */
const IST_MS = 330 * 60000;
const DAY = 86400000;

function weekKey(ms = Date.now()) {
  const d = new Date(ms + IST_MS);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  const p = (n) => String(n).padStart(2, '0');
  return monday.getUTCFullYear() + '-' + p(monday.getUTCMonth() + 1) + '-' + p(monday.getUTCDate());
}

module.exports = { weekKey };
