import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'public');
const apps = JSON.parse(await readFile(resolve(root, 'apps.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(root, 'assets-lock.json'), 'utf8'));
const origin = 'https://github.com/abdulahad17dev/leapmarket-apps/releases/download/apps/';
await mkdir(resolve(out, 'apks'), { recursive: true });
await mkdir(resolve(out, 'icons'), { recursive: true });

async function verify(file, expected) {
  try {
    if ((await stat(file)).size !== expected.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === expected.sha256;
  } catch { return false; }
}

async function prepare(app) {
  const name = app.apk_file;
  const expected = lock[name];
  if (!/^[A-Za-z0-9_.-]+\.apk$/.test(name) || !expected ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size <= 0) {
    throw new Error(`Missing or invalid APK lock: ${name}`);
  }
  const target = resolve(out, 'apks', name);
  if (!(await verify(target, expected))) {
    const local = process.env.APK_SOURCE_DIR ? resolve(process.env.APK_SOURCE_DIR, name) : null;
    if (local && await verify(local, expected)) {
      await copyFile(local, target);
    } else {
      const url = origin + name;
      if (app.apk_url !== url) throw new Error(`Unexpected build download URL for ${name}`);
      const partial = `${target}.part`;
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const idle = new AbortController();
        let idleTimer;
        const resetIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => idle.abort(new Error('Download stalled for 60 seconds')), 60_000);
        };
        try {
          console.log(`Fetching ${name} (${expected.size} bytes), attempt ${attempt}`);
          resetIdle();
          const response = await fetch(url, { signal: AbortSignal.any([idle.signal, AbortSignal.timeout(900_000)]) });
          if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}`);
          let received = 0;
          const limit = new Transform({ transform(chunk, encoding, done) {
            resetIdle();
            received += chunk.length;
            done(received > expected.size ? new Error('APK exceeds locked size') : null, chunk);
          } });
          await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial));
          if (!(await verify(partial, expected))) throw new Error('APK size/SHA-256 mismatch');
          await rename(partial, target);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await rm(partial, { force: true });
        } finally {
          clearTimeout(idleTimer);
        }
      }
      if (lastError) throw new Error(`Failed to prepare ${name}`, { cause: lastError });
    }
  }
  if (!/^\/icons\/[A-Za-z0-9_.-]+\.(png|webp|jpg|jpeg)$/.test(app.icon)) {
    throw new Error(`Invalid icon for ${name}`);
  }
  await copyFile(resolve(root, 'icons', basename(app.icon)), resolve(out, 'icons', basename(app.icon)));
  if (app.screenshots?.length) throw new Error(`Copy screenshots into the server build before publishing ${name}`);
  console.log(`Verified ${name}`);
  return { ...app, apk_url: `/apks/${name}`, sha256: expected.sha256, size_bytes: expected.size };
}

// Two downloads at a time; no APK download is needed when the service starts.
const prepared = [];
for (let i = 0; i < apps.length; i += 2) {
  prepared.push(...await Promise.all(apps.slice(i, i + 2).map(prepare)));
}
await writeFile(resolve(out, 'apps.json'), JSON.stringify(prepared, null, 2) + '\n');
console.log(`Prepared ${prepared.length} apps. All runtime downloads are local to Railway.`);
