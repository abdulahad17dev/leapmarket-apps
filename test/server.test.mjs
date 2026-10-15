import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createMarketServer } from '../server.mjs';

async function cleanup(root) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.match(basename(root), /^redmarket-(test|missing)-[A-Za-z0-9]+$/);
  await rm(root, { recursive: true, force: true });
}

test('catalog, APK, ranges, HEAD, cache and route isolation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'redmarket-test-'));
  await mkdir(join(root, 'apks'));
  await mkdir(join(root, 'icons'));
  await writeFile(join(root, 'apks', 'demo.apk'), '0123456789');
  await writeFile(join(root, 'icons', 'demo.png'), 'icon');
  await writeFile(join(root, 'secret.txt'), 'not public');
  await writeFile(join(root, 'apps.json'), JSON.stringify([
    { name: 'Demo', apk_url: '/apks/demo.apk', icon: '/icons/demo.png', size_bytes: 10, sha256: 'test' },
  ]));
  const server = await createMarketServer(root);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); await cleanup(root); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok', apps: 1 });
  const catalog = await fetch(base + '/apps.json');
  assert.equal((await catalog.json())[0].apk_url, '/apks/demo.apk');
  assert.equal((await fetch(base + '/apps.json', { headers: { 'If-None-Match': catalog.headers.get('etag') } })).status, 304);
  const full = await fetch(base + '/apks/demo.apk');
  assert.equal(full.headers.get('content-length'), '10');
  assert.equal(full.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(await full.text(), '0123456789');
  const partial = await fetch(base + '/apks/demo.apk', { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
  assert.equal(await (await fetch(base + '/apks/demo.apk', { headers: { Range: 'bytes=-3' } })).text(), '789');
  assert.equal((await fetch(base + '/apks/demo.apk', { headers: { Range: 'bytes=20-' } })).status, 416);
  assert.equal((await fetch(base + '/apks/demo.apk', { headers: { Range: 'bytes=0-1,3-4' } })).status, 416);
  const head = await fetch(base + '/apks/demo.apk', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/secret.txt')).status, 404);
  assert.equal((await fetch(base + '/apks/%2e%2e%2fsecret.txt')).status, 404);
  assert.equal((await fetch(base + '/apps.json', { method: 'POST' })).status, 405);
});

test('incomplete APK prevents service readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redmarket-missing-'));
  try {
    await writeFile(join(root, 'apps.json'), JSON.stringify([{ apk_url: '/apks/missing.apk' }]));
    await assert.rejects(createMarketServer(root), /ENOENT/);
  } finally { await cleanup(root); }
});
