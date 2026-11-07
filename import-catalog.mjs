// Explicit, one-time additions delivered with a server release. Existing apps
// and deleted entries remain authoritative; never replace the volume catalog.
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function importCatalog(root, dataRoot, manifestFile) {
  if (!dataRoot) return;
  let imports;
  try { imports = JSON.parse(await readFile(manifestFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!Array.isArray(imports)) throw new Error('Invalid catalog imports');
  const catalogFile = resolve(dataRoot, 'catalog.json');
  const before = await readFile(catalogFile, 'utf8');
  const state = JSON.parse(before);
  if (!Array.isArray(state.apps) || !Array.isArray(state.trash) || !Number.isSafeInteger(state.revision))
    throw new Error('Invalid persistent catalog for import');
  const completed = state.applied_imports || [];
  if (!Array.isArray(completed)) throw new Error('Invalid import history');
  const pending = imports.filter(entry => !completed.includes(entry.id));
  if (!pending.length) return;
  const bundled = JSON.parse(await readFile(resolve(root, 'apps.json'), 'utf8'));
  const next = structuredClone(state);
  next.applied_imports = [...completed];
  for (const entry of pending) {
    if (!/^[a-z0-9-]+$/.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error('Invalid import identity');
    const exists = [...next.apps, ...next.trash].some(app => app.package_name === entry.package_name);
    if (!exists) {
      const app = bundled.find(app => app.package_name === entry.package_name && app.sha256 === entry.sha256);
      if (!app || !Number.isSafeInteger(app.size_bytes) || app.size_bytes <= 0)
        throw new Error('Missing verified bundled app');
      for (const route of [app.apk_url, app.icon, ...(app.screenshots || [])].filter(Boolean)) {
        if (!/^\/(apks|icons|screenshots)\/[A-Za-z0-9_.-]+$/.test(route)) throw new Error('Invalid import path');
        const source = resolve(root, '.' + route), target = resolve(dataRoot, '.' + route);
        const expected = await sha256(source);
        if (route === app.apk_url && (expected !== entry.sha256 || (await stat(source)).size !== app.size_bytes))
          throw new Error('Bundled APK integrity mismatch');
        await mkdir(dirname(target), { recursive: true });
        let present = false;
        try { present = (await sha256(target)) === expected; if (!present) throw new Error('Import asset collision'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!present) {
          const temp = target + '.' + randomUUID() + '.pending';
          try {
            await copyFile(source, temp);
            if (await sha256(temp) !== expected) throw new Error('Import copy integrity mismatch');
            await rename(temp, target);
          } finally { await rm(temp, { force: true }); }
        }
      }
      next.apps.push(app);
    }
    next.applied_imports.push(entry.id);
  }
  next.revision++;
  const backups = resolve(dataRoot, 'backups');
  await mkdir(backups, { recursive: true });
  await writeFile(resolve(backups, 'before-import-' + randomUUID() + '.json'), before, { flag: 'wx', mode: 0o600 });
  const temp = catalogFile + '.' + randomUUID() + '.pending';
  try {
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (await readFile(catalogFile, 'utf8') !== before) throw new Error('Catalog changed during import; retry deployment');
    await rename(temp, catalogFile);
  } finally { await rm(temp, { force: true }); }
}
