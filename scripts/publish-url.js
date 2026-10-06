#!/usr/bin/env node
'use strict';
/**
 * Writes the current public address of this server into server.json (the file the apps read from GitHub).
 *   npm run publish-url          -> only writes server.json
 *   npm run publish-url -- --push -> also git commit + push (so the apps see the new address)
 * Public address = PUBLIC_URL, or the GitHub Codespaces forwarded address (https://<codespace>-<port>.app.github.dev).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { publicBaseUrl } = require('../src/publicurl');

const file = path.join(__dirname, '..', 'server.json');
const url = publicBaseUrl();
if (!url) { console.error('No public address found. Set PUBLIC_URL, or run this inside a GitHub Codespace.'); process.exit(1); }

let old = {};
try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first time */ }
const changed = old.baseUrl !== url;
if (changed) fs.writeFileSync(file, JSON.stringify({ baseUrl: url, updatedAt: Date.now() }, null, 2) + '\n');
console.log(changed ? 'server.json updated: ' + url : 'server.json already has: ' + url);

if (process.argv.includes('--push') && changed) {
  const git = (...a) => execFileSync('git', a, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  try { git('add', 'server.json'); git('commit', '-m', 'Update server address'); git('push'); }
  catch (e) { console.error('git push failed (server.json is written, push it by hand):', e.message); }
}

// Codespaces ports are private by default; the phone app cannot log in to GitHub, so the port must be public.
if (process.env.CODESPACE_NAME) {
  try { execFileSync('gh', ['codespace', 'ports', 'visibility', (process.env.PORT || 3000) + ':public', '-c', process.env.CODESPACE_NAME], { stdio: 'inherit' }); }
  catch (_) { console.error('Could not make the port public automatically. In the Codespace: Ports tab > right click the port > Port Visibility > Public.'); }
}
