/*
 * store.js — project & file management with path-traversal protection,
 * plus full-text project search.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let PROJECTS_DIR = null;
let TEMPLATES_DIR = null;

function init({ projectsDir, templatesDir }) {
  PROJECTS_DIR = projectsDir;
  TEMPLATES_DIR = templatesDir;
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  if (!fs.readdirSync(PROJECTS_DIR).length) {
    copyDir(path.join(TEMPLATES_DIR, 'hello'), path.join(PROJECTS_DIR, 'hello-droid'));
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function safeName(name) {
  const n = String(name || '').trim().replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 60);
  if (!n || n === '.' || n === '..') throw new Error('invalid name');
  return n;
}

function projectRoot(project) {
  const p = path.resolve(PROJECTS_DIR, safeName(project));
  if (!p.startsWith(PROJECTS_DIR + path.sep)) throw new Error('bad project path');
  if (!fs.existsSync(p)) throw new Error('project not found: ' + project);
  return p;
}

function resolveIn(project, rel) {
  const root = projectRoot(project);
  const p = path.resolve(root, String(rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('path escapes project');
  if (p.includes(`${path.sep}build${path.sep}`) || p.endsWith(`${path.sep}build`)) throw new Error('build/ is managed by code-droid');
  return p;
}

function listProjects() {
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      let appName = e.name;
      try { appName = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, e.name, 'code-droid.json'), 'utf8')).appName || appName; } catch {}
      return { id: e.name, name: appName };
    });
}

function fileTree(project) {
  const root = projectRoot(project);
  function node(dir, relBase) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (e.name === 'build' || e.name.startsWith('.')) continue;
      const rel = relBase ? relBase + '/' + e.name : e.name;
      if (e.isDirectory()) out.push({ name: e.name, path: rel, type: 'dir', children: node(path.join(dir, e.name), rel) });
      else {
        let size = 0;
        try { size = fs.statSync(path.join(dir, e.name)).size; } catch {}
        out.push({ name: e.name, path: rel, type: 'file', size });
      }
    }
    return out;
  }
  return node(root, '');
}

function readFile(project, rel) {
  const p = resolveIn(project, rel);
  const st = fs.statSync(p);
  return { content: fs.readFileSync(p, 'utf8'), mtime: st.mtimeMs, size: st.size };
}

function writeFile(project, rel, content) {
  const p = resolveIn(project, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return fs.statSync(p).mtimeMs;
}

function create(project, rel, type) {
  const p = resolveIn(project, rel);
  if (fs.existsSync(p)) throw new Error('already exists: ' + rel);
  if (type === 'dir') fs.mkdirSync(p, { recursive: true });
  else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); }
}

function remove(project, rel) {
  fs.rmSync(resolveIn(project, rel), { recursive: true, force: true });
}

function createProject(name) {
  const id = safeName(name).toLowerCase().replace(/\s+/g, '-');
  const dst = path.join(PROJECTS_DIR, id);
  if (fs.existsSync(dst)) throw new Error('project already exists: ' + id);
  copyDir(path.join(TEMPLATES_DIR, 'hello'), dst);
  return { id, name };
}

function uniqueProjectId(base) {
  const clean = safeName(base).toLowerCase().replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'imported';
  if (!fs.existsSync(path.join(PROJECTS_DIR, clean))) return clean;
  for (let i = 2; i < 100; i++) {
    const id = `${clean}-${i}`;
    if (!fs.existsSync(path.join(PROJECTS_DIR, id))) return id;
  }
  throw new Error('could not find a free project name');
}

function importDir(tmpUnpackedDir, wantedName) {
  // If the zip has a single top-level folder, that's the project root.
  const entries = fs.readdirSync(tmpUnpackedDir, { withFileTypes: true });
  let src = tmpUnpackedDir;
  if (entries.length === 1 && entries[0].isDirectory()) src = path.join(tmpUnpackedDir, entries[0].name);
  const id = uniqueProjectId(wantedName || entries[0]?.name || 'imported');
  copyDir(src, path.join(PROJECTS_DIR, id));
  return { id };
}

function apkPath(project) {
  const p = path.join(projectRoot(project), 'build', 'app-debug.apk');
  return fs.existsSync(p) ? p : null;
}

const TEXT_EXT = new Set(['kt', 'kts', 'java', 'xml', 'json', 'md', 'txt', 'gradle', 'properties', 'pro', 'html', 'css', 'js']);
function search(project, query, opts = {}) {
  if (!query || query.length < 2) throw new Error('query too short');
  const root = projectRoot(project);
  const needle = String(query);
  const needleLC = needle.toLowerCase();
  const ci = opts.caseInsensitive !== false;
  const MAX_RESULTS = 300, MAX_FILE = 1024 * 1024;
  const results = [];
  const stack = [root];
  while (stack.length && results.length < MAX_RESULTS) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= MAX_RESULTS) break;
      if (e.name === 'build' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      const ext = e.name.split('.').pop().toLowerCase();
      if (!TEXT_EXT.has(ext)) continue;
      try {
        if (fs.statSync(p).size > MAX_FILE) continue;
        const rel = path.relative(root, p).split(path.sep).join('/');
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        for (let i = 0; i < lines.length && results.length < MAX_RESULTS; i++) {
          const hay = ci ? lines[i].toLowerCase() : lines[i];
          const col = hay.indexOf(ci ? needleLC : needle);
          if (col !== -1) results.push({ file: rel, line: i + 1, col: col + 1, preview: lines[i].trim().slice(0, 160) });
        }
      } catch { /* unreadable — skip */ }
    }
  }
  return { results, truncated: results.length >= MAX_RESULTS };
}

module.exports = {
  init, listProjects, fileTree, readFile, writeFile, create, remove,
  createProject, apkPath, projectRoot, search, importDir, uniqueProjectId,
};
