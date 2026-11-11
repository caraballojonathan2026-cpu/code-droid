#!/usr/bin/env node
/*
 * code-droid server — zero-dependency Node.js backend.
 *
 * Serves the web IDE, manages projects on disk, runs the direct Android
 * build pipeline. No frameworks, no Gradle, no npm dependencies.
 *
 * Run it via `npm start` (server/launcher.js) so the IDE's ⟳ Restart
 * button can respawn it; run it directly for development.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const { discoverTools } = require('./toolchain');
const { buildProject } = require('./builder');
const git = require('./git');
const pkg = require('../package.json');
const store = require('./store');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const RELEASES_DIR = path.join(ROOT, 'releases');
const RESTART_CODE = 75; // honored by launcher.js

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive',
  '.zip': 'application/zip',
};

store.init({ projectsDir: PROJECTS_DIR, templatesDir: TEMPLATES_DIR });

let buildRunning = false; // single-flight: one build at a time (low-RAM machines!)

/* CORS: lets the official hosted IDE (e.g. GitHub Pages) or localhost drive a
 * server running on the user's own machine — builds stay local, the browser page
 * is just the remote control — while blocking arbitrary third-party websites.
 * Extra origins can be opted in via CORS_ORIGINS="https://a.example,https://b.example". */
const DEFAULT_TRUSTED_ORIGINS = new Set([
  'https://caraballojonathan2026-cpu.github.io',
]);
function configuredOrigins() {
  const raw = (process.env.CORS_ORIGINS || '').trim();
  if (!raw || raw === '*') return raw;
  const s = new Set(DEFAULT_TRUSTED_ORIGINS);
  for (const part of raw.split(',')) { const o = part.trim().replace(/\/+$/, ''); if (o) s.add(o); }
  return s;
}
function isAllowedOrigin(origin, req) {
  if (!origin) return false;
  const cfg = configuredOrigins();
  if (cfg === '*') return true;
  try {
    const u = new URL(origin);
    if (req && req.headers && u.host === req.headers.host) return true;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]') return true;
    if (cfg instanceof Set && cfg.has(u.origin)) return true;
    return DEFAULT_TRUSTED_ORIGINS.has(u.origin);
  } catch {
    return false;
  }
}
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(origin, req)) return { 'Vary': 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Vary': 'Origin',
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); }
  catch { return null; }
}

function send(res, status, data, headers = {}) {
  const isObj = typeof data === 'object' && !(data instanceof Buffer);
  const body = isObj ? JSON.stringify(data, null, 2) : data;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!over) {
          over = true;
          chunks.length = 0;
          const err = new Error('body too large');
          err.statusCode = 413;
          reject(err);
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new Error('invalid JSON body'); }
}

function serveStatic(res, urlPath) {
  let rel = safeDecode(urlPath);
  if (rel === null) return send(res, 400, { error: 'malformed URL' });
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(WEB_DIR, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (!file.startsWith(WEB_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found: ' + rel });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

async function handleApi(req, res, u) {
  const p = u.pathname;
  const q = u.searchParams;

  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, name: 'code-droid', version: pkg.version });

  if (req.method === 'GET' && p === '/api/tools') return send(res, 200, discoverTools());

  if (req.method === 'GET' && p === '/api/projects') return send(res, 200, { projects: store.listProjects() });

  if (req.method === 'POST' && p === '/api/project/new') {
    const { name } = await readJson(req);
    return send(res, 200, { project: store.createProject(name) });
  }

  if (req.method === 'GET' && p === '/api/files') {
    const { tree, truncated, nodeCount } = store.fileTree(q.get('project'));
    return send(res, 200, { tree, truncated, nodeCount });
  }

  if (req.method === 'GET' && p === '/api/file') {
    const { content, mtime, size } = store.readFile(q.get('project'), q.get('path'));
    return send(res, 200, { path: q.get('path'), content, mtime, size });
  }

  if (req.method === 'GET' && p === '/api/file/raw') {
    const { buf, name } = store.readRawFile(q.get('project'), q.get('path'));
    const safeDisp = name.replace(/["\\\r\n]/g, '_');
    return send(res, 200, buf, {
      'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeDisp}"`,
    });
  }

  if (req.method === 'POST' && p === '/api/file') {
    const { project, path: rel, content } = await readJson(req);
    const mtime = store.writeFile(project, rel, String(content ?? ''));
    return send(res, 200, { saved: rel, mtime });
  }

  if (req.method === 'POST' && p === '/api/file/new') {
    const { project, path: rel, type } = await readJson(req);
    store.create(project, rel, type === 'dir' ? 'dir' : 'file');
    return send(res, 200, { created: rel });
  }

  if (req.method === 'POST' && p === '/api/file/delete') {
    const { project, path: rel } = await readJson(req);
    store.remove(project, rel);
    return send(res, 200, { deleted: rel });
  }

  if (req.method === 'POST' && p === '/api/file/rename') {
    const { project, path: rel, newPath } = await readJson(req);
    store.rename(project, rel, String(newPath || ''));
    return send(res, 200, { renamed: rel, to: newPath });
  }

  if (req.method === 'GET' && p === '/api/search') {
    const out = store.search(q.get('project'), q.get('q') || '', { caseInsensitive: q.get('ci') !== '0' });
    return send(res, 200, out);
  }

  // ---- git (commit button) ----
  if (req.method === 'GET' && p === '/api/git/status') {
    const safeProj = path.basename(store.projectRoot(q.get('project')));
    return send(res, 200, git.status(ROOT, safeProj));
  }

  if (req.method === 'POST' && p === '/api/git/commit') {
    const { project, message, description } = await readJson(req);
    const safeProj = path.basename(store.projectRoot(project));
    const r = git.commit(ROOT, safeProj, message, description);
    return send(res, r.ok ? 200 : 400, r);
  }

  // ---- import / export ----
  if (req.method === 'GET' && p === '/api/project/export') {
    const root = store.projectRoot(q.get('project'));
    const safeProj = path.basename(root);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-export-'));
    const tmp = path.join(workDir, `${safeProj}.zip`);
    try {
      execFileSync('zip', ['-qr', tmp, '.', '-x', 'build/*', 'build'], { cwd: root });
      const buf = fs.readFileSync(tmp);
      return send(res, 200, buf, {
        'Content-Type': MIME['.zip'],
        'Content-Disposition': `attachment; filename="${safeProj}.zip"`,
      });
    } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
  }

  if (req.method === 'POST' && p === '/api/project/import') {
    const raw = await readBody(req, 64 * 1024 * 1024);
    if (!raw.length) throw new Error('empty upload');
    const wanted = (q.get('name') || 'imported').replace(/\.zip$/i, '');
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-import-'));
    const tmpZip = path.join(workDir, 'upload.zip');
    const tmpDir = path.join(workDir, 'unpacked');
    fs.writeFileSync(tmpZip, raw);
    try {
      const listing = execFileSync('unzip', ['-Z1', tmpZip], { encoding: 'utf8' });
      for (const entry of listing.split(/\r?\n/)) {
        if (!entry) continue;
        const norm = path.posix.normalize(entry.replace(/\\/g, '/'));
        if (norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm)) {
          throw new Error('unsafe path in zip archive: ' + entry);
        }
      }
      fs.mkdirSync(tmpDir, { recursive: true });
      execFileSync('unzip', ['-q', '-o', tmpZip, '-d', tmpDir]);
      const { id } = store.importDir(tmpDir, wanted);
      return send(res, 200, { imported: id });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  // ---- build ----
  if (req.method === 'POST' && p === '/api/build') {
    if (buildRunning) return send(res, 409, { error: 'A build is already running. On low-RAM machines code-droid compiles one app at a time.' });
    const { project } = await readJson(req);
    buildRunning = true;
    try {
      const result = await buildProject(store.projectRoot(project), discoverTools());
      return send(res, result.ok ? 200 : 500, result);
    } finally {
      buildRunning = false;
    }
  }

  if (req.method === 'GET' && p === '/api/apk') {
    const safeProj = path.basename(store.projectRoot(q.get('project')));
    const apkPath = store.apkPath(safeProj);
    if (!apkPath) return send(res, 404, { error: 'No APK yet — build the project first.' });
    const buf = fs.readFileSync(apkPath);
    return send(res, 200, buf, {
      'Content-Type': MIME['.apk'],
      'Content-Disposition': `attachment; filename="${safeProj}-debug.apk"`,
    });
  }

  // ---- restart (exits with RESTART_CODE so launcher.js respawns us) ----
  if (req.method === 'POST' && p === '/api/restart') {
    send(res, 200, { restarting: true, note: 'Server exiting with code 75; launcher.js will respawn it. If it was started directly (node server/server.js), it will simply stop.' });
    setTimeout(() => process.exit(RESTART_CODE), 100);
    return;
  }

  return send(res, 404, { error: 'unknown endpoint: ' + p });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { // CORS / Private-Network preflight
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req)) {
      return send(res, 403, { error: 'Origin not allowed' });
    }
    res.writeHead(204);
    return res.end();
  }
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname.startsWith('/api/')) {
      if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req)) {
        return send(res, 403, { error: 'Origin not allowed' });
      }
      if (req.headers['sec-fetch-site'] === 'cross-site' && (!req.headers.origin || !isAllowedOrigin(req.headers.origin, req))) {
        return send(res, 403, { error: 'Cross-site request blocked' });
      }
      return await handleApi(req, res, u);
    }
    if (u.pathname.startsWith('/releases/')) {
      // built APKs, downloadable as attachments
      const rel = safeDecode(u.pathname.slice('/releases/'.length));
      if (!rel) return send(res, 400, { error: 'invalid path' });
      const file = path.resolve(RELEASES_DIR, rel);
      if (!file.startsWith(RELEASES_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
      return fs.readFile(file, (err, buf) => {
        if (err) return send(res, 404, { error: 'not found — build something first' });
        const safeName = path.basename(file).replace(/["\\\r\n]/g, '_');
        send(res, 200, buf, {
          'Content-Type': MIME['.apk'],
          'Content-Disposition': `attachment; filename="${safeName}"`,
        });
      });
    }
    return serveStatic(res, u.pathname);
  } catch (e) {
    const code = e.statusCode || (/not found/i.test(e.message) ? 404 : 400);
    const extra = code === 413 ? { Connection: 'close' } : {};
    if (code === 413) res.on('finish', () => req.destroy());
    return send(res, code, { error: e.message }, extra);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`code-droid IDE ready:  http://${HOST}:${PORT}`);
    console.log(`projects directory:    ${PROJECTS_DIR}`);
  });
}

module.exports = { server, isAllowedOrigin };
