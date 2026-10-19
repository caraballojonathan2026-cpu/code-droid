#!/usr/bin/env node
/*
 * code-droid server — zero-dependency Node.js backend.
 *
 * Serves the web IDE, manages projects on disk, and runs the
 * direct Android build pipeline (aapt2 -> kotlinc -> d8 -> zipalign -> apksigner).
 * No frameworks, no Gradle, no npm dependencies. Runs happily in <100MB RAM.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { discoverTools } = require('./toolchain');
const { buildProject } = require('./builder');
const store = require('./store');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const TEMPLATES_DIR = path.join(ROOT, 'templates');

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
};

store.init({ projectsDir: PROJECTS_DIR, templatesDir: TEMPLATES_DIR });

let buildRunning = false; // single-flight: one build at a time (low RAM machines!)

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found: ' + rel });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

async function handleApi(req, res, u) {
  const p = u.pathname;
  const q = u.searchParams;

  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, name: 'code-droid' });

  if (req.method === 'GET' && p === '/api/tools') {
    return send(res, 200, discoverTools());
  }

  if (req.method === 'GET' && p === '/api/projects') {
    return send(res, 200, { projects: store.listProjects() });
  }

  if (req.method === 'POST' && p === '/api/project/new') {
    const { name } = await readBody(req);
    const project = store.createProject(name);
    return send(res, 200, { project });
  }

  if (req.method === 'GET' && p === '/api/files') {
    const project = q.get('project');
    return send(res, 200, { tree: store.fileTree(project) });
  }

  if (req.method === 'GET' && p === '/api/file') {
    const project = q.get('project'); const rel = q.get('path');
    return send(res, 200, { path: rel, content: store.readFile(project, rel) });
  }

  if (req.method === 'POST' && p === '/api/file') {
    const { project, path: rel, content } = await readBody(req);
    store.writeFile(project, rel, String(content ?? ''));
    return send(res, 200, { saved: rel });
  }

  if (req.method === 'POST' && p === '/api/file/new') {
    const { project, path: rel, type } = await readBody(req);
    store.create(project, rel, type === 'dir' ? 'dir' : 'file');
    return send(res, 200, { created: rel });
  }

  if (req.method === 'POST' && p === '/api/file/delete') {
    const { project, path: rel } = await readBody(req);
    store.remove(project, rel);
    return send(res, 200, { deleted: rel });
  }

  if (req.method === 'POST' && p === '/api/build') {
    if (buildRunning) return send(res, 409, { error: 'A build is already running. On low-RAM machines code-droid compiles one app at a time.' });
    const { project } = await readBody(req);
    buildRunning = true;
    try {
      const result = buildProject(store.projectRoot(project), discoverTools());
      return send(res, result.ok ? 200 : 500, result);
    } finally {
      buildRunning = false;
    }
  }

  if (req.method === 'GET' && p === '/api/apk') {
    const project = q.get('project');
    const apkPath = store.apkPath(project);
    if (!apkPath) return send(res, 404, { error: 'No APK yet — build the project first.' });
    const buf = fs.readFileSync(apkPath);
    return send(res, 200, buf, {
      'Content-Type': MIME['.apk'],
      'Content-Disposition': `attachment; filename="${project}-debug.apk"`,
    });
  }

  return send(res, 404, { error: 'unknown endpoint: ' + p });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    return serveStatic(res, u.pathname);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`code-droid IDE ready:  http://${HOST}:${PORT}`);
  console.log(`projects directory:    ${PROJECTS_DIR}`);
});
