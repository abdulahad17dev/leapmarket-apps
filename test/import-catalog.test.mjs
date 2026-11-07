import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { importCatalog } from '../import-catalog.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'redmarket-import-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(basename(root), /^redmarket-import-[A-Za-z0-9]+$/);
    await rm(root, { recursive: true, force: true });
  });
  const seed = join(root, 'public'), data = join(root, 'data'), manifest = join(root, 'imports.json');
  await mkdir(join(seed, 'apks'), { recursive: true }); await mkdir(data);
  await writeFile(join(seed, 'apks', 'maps.apk'), 'verified apk');
  const app = { package_name: 'example.maps', apk_url: '/apks/maps.apk', icon: '', size_bytes: 12,
    sha256: createHash('sha256').update('verified apk').digest('hex') };
  await writeFile(join(seed, 'apps.json'), JSON.stringify([app]));
  await writeFile(manifest, JSON.stringify([{ id: 'maps-one', package_name: app.package_name, sha256: app.sha256 }]));
  const original = { revision: 42, apps: [{ package_name: 'existing.app', name: 'Owner edited name' }],
    trash: [{ package_name: 'deleted.app' }], custom: { preserved: true } };
  const file = join(data, 'catalog.json');
  await writeFile(file, JSON.stringify(original));
  return { seed, data, manifest, file, app, original };
}

test('imports only the requested app, preserves catalog and keeps assets for rollback', async t => {
  const f = await fixture(t);
  await importCatalog(f.seed, f.data, f.manifest);
  const state = JSON.parse(await readFile(f.file));
  assert.deepEqual(state.apps, [...f.original.apps, f.app]);
  assert.deepEqual(state.trash, f.original.trash);
  assert.deepEqual(state.custom, f.original.custom);
  assert.equal(state.revision, 43);
  assert.equal(await readFile(join(f.data, 'apks', 'maps.apk'), 'utf8'), 'verified apk');
  const backups = await readdir(join(f.data, 'backups'));
  assert.deepEqual(JSON.parse(await readFile(join(f.data, 'backups', backups[0]))), f.original);
  await importCatalog(f.seed, f.data, f.manifest);
  assert.deepEqual(JSON.parse(await readFile(f.file)), state);
  // Owner can subsequently delete it: redeployment does not resurrect it.
  state.apps.pop(); state.trash.push(f.app);
  await writeFile(f.file, JSON.stringify(state));
  await importCatalog(f.seed, f.data, f.manifest);
  assert.deepEqual(JSON.parse(await readFile(f.file)), state);
});

test('never replaces an existing app or restores a trashed app', async t => {
  for (const location of ['apps', 'trash']) {
    const f = await fixture(t);
    f.original[location].push({ ...f.app, version_code: 999, name: 'Owner choice' });
    await writeFile(f.file, JSON.stringify(f.original));
    await importCatalog(f.seed, f.data, f.manifest);
    const state = JSON.parse(await readFile(f.file));
    assert.deepEqual(state.apps, f.original.apps); assert.deepEqual(state.trash, f.original.trash);
  }
});

test('corrupt bundled APK leaves the original catalog untouched', async t => {
  const f = await fixture(t);
  const before = await readFile(f.file, 'utf8');
  await writeFile(join(f.seed, 'apks', 'maps.apk'), 'corrupt data');
  await assert.rejects(importCatalog(f.seed, f.data, f.manifest), /integrity mismatch/);
  assert.equal(await readFile(f.file, 'utf8'), before);
});
