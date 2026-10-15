import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const contentTypes = {
  '.apk': 'application/vnd.android.package-archive',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

export async function createMarketServer(directory, dataDirectory = process.env.DATA_DIR) {
  const root = resolve(directory);
  const dataRoot = dataDirectory ? resolve(dataDirectory) : null;
  const catalogFile = dataRoot ? resolve(dataRoot, 'catalog.json') : resolve(root, 'apps.json');
  let snapshot, stamp, loading;
  async function load() {
  const info = await stat(catalogFile);
  const parsed = JSON.parse(await readFile(catalogFile));
  const apps = Array.isArray(parsed) ? parsed : parsed.apps;
  if (!Array.isArray(apps)) throw new Error('Invalid catalog');
  const catalog = Buffer.from(JSON.stringify(apps, null, 2) + '\n');
  const routes = new Map();
  for (const app of apps) {
    for (const route of [app.apk_url, app.icon, ...(app.screenshots || [])].filter(Boolean)) {
      if (!/^\/(apks|icons|screenshots)\/[A-Za-z0-9_.-]+$/.test(route)) {
        throw new Error(`Catalog contains a non-local or invalid asset path: ${route}`);
      }
      let file = resolve(root, '.' + route);
      if (dataRoot) {
        const uploaded = resolve(dataRoot, '.' + route);
        try { await access(uploaded); file = uploaded; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`Not a file: ${route}`);
      if (route === app.apk_url && info.size !== app.size_bytes) throw new Error(`Wrong APK size: ${route}`);
      routes.set(route, {
        file, size: info.size, type: contentTypes[extname(route)] || 'application/octet-stream',
        etag: route === app.apk_url ? `"${app.sha256}"` : `"${createHash('sha256').update(await readFile(file)).digest('hex')}"`,
      });
    }
  }
  const catalogTag = `"${createHash('sha256').update(catalog).digest('hex')}"`;
  snapshot = { apps, catalog, routes, catalogTag };
  stamp = `${info.mtimeMs}:${info.size}`;
  }
  await load();

  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      const bytes = Buffer.from(body);
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(405, '{"error":"Method not allowed"}');
    }
    let path;
    try { path = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { return send(400, '{"error":"Invalid path"}'); }
    try {
      const info = await stat(catalogFile);
      if (`${info.mtimeMs}:${info.size}` !== stamp) {
        if (!loading) loading = load().finally(() => { loading = null; });
        await loading;
      }
    } catch (error) { console.error('Catalog reload failed:', error.code || error.name); }
    const { apps, catalog, routes, catalogTag } = snapshot;
    if (path === '/healthz') {
      res.setHeader('Cache-Control', 'no-store');
      return send(200, JSON.stringify({ status: 'ok', apps: apps.length }));
    }
    if (path === '/') return send(200, '{"service":"RedMarket","catalog":"/apps.json"}');
    if (path === '/apps.json') {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', catalogTag);
      if (req.headers['if-none-match'] === catalogTag) { res.writeHead(304); return res.end(); }
      return send(200, catalog);
    }
    const asset = routes.get(path);
    if (!asset) return send(404, '{"error":"Not found"}');
    res.setHeader('Content-Type', asset.type);
    res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    res.setHeader('ETag', asset.etag);
    res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers['if-none-match'] === asset.etag) { res.writeHead(304); return res.end(); }
    let start = 0;
    let end = asset.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && req.method === 'GET' && (!req.headers['if-range'] || req.headers['if-range'] === asset.etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.setHeader('Content-Range', `bytes */${asset.size}`);
        return send(416, '{"error":"Invalid range"}');
      }
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(Number(match[2]), end);
      } else {
        const suffix = Number(match[2]);
        start = suffix > 0 ? Math.max(0, asset.size - suffix) : asset.size;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.size) {
        res.setHeader('Content-Range', `bytes */${asset.size}`);
        return send(416, '{"error":"Unsatisfiable range"}');
      }
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${asset.size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    res.writeHead(status);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(asset.file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = await createMarketServer(resolve(import.meta.dirname, 'public'));
  server.listen(port, '0.0.0.0', () => console.log(`RedMarket listening on 0.0.0.0:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 10_000).unref();
    });
  }
}
