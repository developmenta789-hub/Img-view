'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fakeFs } = require('./fakefs');
const fsl = require('../src/fslang');

const code = (c) => (e) => e.code === c;

test('first save = version 1, same language again keeps the version, a change adds 1', async () => {
  const fs = fakeFs();
  assert.deepStrictEqual(await fsl.getLang(fs, 'u1'), { lang: null, version: 0 });
  assert.deepStrictEqual(await fsl.setLang(fs, 'u1', { lang: 'hi' }), { lang: 'hi', version: 1 });
  assert.deepStrictEqual(await fsl.setLang(fs, 'u1', { lang: 'hi' }), { lang: 'hi', version: 1 });
  assert.deepStrictEqual(await fsl.setLang(fs, 'u1', { lang: 'en' }), { lang: 'en', version: 2 });
  assert.deepStrictEqual(await fsl.setLang(fs, 'u1', { lang: 'zh-CN' }), { lang: 'zh-CN', version: 3 });
  assert.deepStrictEqual(await fsl.getLang(fs, 'u1'), { lang: 'zh-CN', version: 3 });
  assert.deepStrictEqual(await fsl.getLang(fs, 'u2'), { lang: null, version: 0 });
});

test('bad language codes are refused', async () => {
  const fs = fakeFs();
  for (const lang of ['', 'x', 'hindi!', '<script>', 'en-', 'abcd', 5, null, undefined]) {
    await assert.rejects(fsl.setLang(fs, 'u1', { lang }), code('bad_lang'));
  }
  await assert.rejects(fsl.setLang(fs, 'u1', null), code('bad_lang'));
  assert.ok(!fs.store.has('userLang/u1'));
});

test('HTTP: login needed, each player has their own language', async () => {
  const { start } = require('./helpers');
  const fs = fakeFs();
  const s = await start({}, fs);
  try {
    assert.strictEqual((await s.call('GET', '/api/v2/lang')).status, 401);
    assert.strictEqual((await s.call('POST', '/api/v2/lang', { body: { lang: 'hi' } })).status, 401);
    const a = await s.call('POST', '/api/v2/lang', { token: 'u1', body: { lang: 'hi' } });
    assert.deepStrictEqual([a.status, a.json], [200, { lang: 'hi', version: 1 }]);
    assert.strictEqual((await s.call('POST', '/api/v2/lang', { token: 'u1', body: { lang: 'bad!' } })).status, 400);
    assert.deepStrictEqual((await s.call('GET', '/api/v2/lang', { token: 'u1' })).json, { lang: 'hi', version: 1 });
    assert.deepStrictEqual((await s.call('GET', '/api/v2/lang', { token: 'u2' })).json, { lang: null, version: 0 });
  } finally { await s.stop(); }
});
