/*
 * store.js — project & file management with path-traversal protection,
 * plus full-text project search.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let PROJECTS_DIR = null;
let TEMPLATES_DIR = null;

/* Server-side tree cache: the file tree of a big project can have 10K+ nodes,
 * so we compute it once and only recompute after an actual write through the
 * API (all mutations go through this module). */
const treeCache = new Map(); // project -> {tree, truncated, nodeCount}
const NODE_CAP = 25000;      // safety bound so a pathological tree can't OOM us

function invalidate(project) { treeCache.delete(project); }

function init({ projectsDir, templatesDir }) {
  PROJECTS_DIR = projectsDir;
  TEMPLATES_DIR = templatesDir;
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  if (!fs.readdirSync(PROJECTS_DIR).length) {
    copyDir(path.join(TEMPLATES_DIR, 'hello'), path.join(PROJECTS_DIR, 'hello-droid'));
  }
}

function copyDir(src, dst, opts = {}) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) {
      if (opts.rejectSymlinks) throw new Error('unsafe symbolic link in archive: ' + e.name);
      continue;
    }
    if (e.isDirectory()) copyDir(s, d, opts);
    else if (e.isFile()) fs.copyFileSync(s, d);
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
  const raw = String(rel || '').trim();
  if (!raw) throw new Error('file path required');
  const p = path.resolve(root, raw);
  if (p === root || !p.startsWith(root + path.sep)) throw new Error('path escapes project');
  const relNorm = path.relative(root, p);
  if (relNorm.split(path.sep)[0] === 'build') throw new Error('build/ is managed by code-droid');
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
  const cached = treeCache.get(project);
  if (cached) return cached;
  const root = projectRoot(project);
  let nodeCount = 0;
  let truncated = false;
  function node(dir, relBase) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (e.name === 'build' || e.name.startsWith('.')) continue;
      const rel = relBase ? relBase + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (++nodeCount > NODE_CAP) { truncated = true; continue; }
        out.push({ name: e.name, path: rel, type: 'dir', children: node(path.join(dir, e.name), rel) });
      } else {
        if (++nodeCount > NODE_CAP) { truncated = true; continue; }
        let size = 0;
        try { size = fs.statSync(path.join(dir, e.name)).size; } catch {}
        out.push({ name: e.name, path: rel, type: 'file', size });
      }
    }
    return out;
  }
  const result = { tree: node(root, ''), truncated, nodeCount };
  treeCache.set(project, result);
  return result;
}

const MAX_OPEN_SIZE = 8 * 1024 * 1024; // never slurp more than 8MB into the editor
function isLikelyBinary(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function readFile(project, rel) {
  const p = resolveIn(project, rel);
  if (!fs.existsSync(p)) throw new Error('file not found: ' + rel);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error('cannot open a directory as a file: ' + rel);
  if (st.size > MAX_OPEN_SIZE) throw new Error(`file too large to open (${Math.round(st.size / 1048576)}MB > 8MB limit)`);
  const buf = fs.readFileSync(p);
  if (isLikelyBinary(buf)) throw new Error('binary file cannot be edited as text (right-click → Download this file)');
  return { content: buf.toString('utf8'), mtime: st.mtimeMs, size: st.size };
}

function readRawFile(project, rel) {
  const p = resolveIn(project, rel);
  if (!fs.existsSync(p)) throw new Error('file not found: ' + rel);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error('cannot download a directory as a file: ' + rel);
  return { buf: fs.readFileSync(p), name: path.basename(p), size: st.size };
}

function writeFile(project, rel, content) {
  const p = resolveIn(project, rel);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) throw new Error('cannot overwrite a directory with a file: ' + rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  invalidate(project);
  return fs.statSync(p).mtimeMs;
}

function create(project, rel, type) {
  const p = resolveIn(project, rel);
  if (fs.existsSync(p)) throw new Error('already exists: ' + rel);
  if (type === 'dir') fs.mkdirSync(p, { recursive: true });
  else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); }
  invalidate(project);
}

function remove(project, rel) {
  const p = resolveIn(project, rel);
  if (!fs.existsSync(p)) throw new Error('not found: ' + rel);
  fs.rmSync(p, { recursive: true, force: true });
  invalidate(project);
}

function rename(project, rel, newRel) {
  const from = resolveIn(project, rel);
  const to = resolveIn(project, newRel);
  if (!fs.existsSync(from)) throw new Error('not found: ' + rel);
  if (fs.existsSync(to)) throw new Error('already exists: ' + newRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  invalidate(project);
}

function escapeAndroidXmlString(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'");
}

function createProject(name) {
  const cleanName = String(name || '').trim();
  const id = safeName(cleanName).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id || id === '.' || id === '..') throw new Error('invalid name');
  const dst = path.join(PROJECTS_DIR, id);
  if (fs.existsSync(dst)) throw new Error('project already exists: ' + id);
  copyDir(path.join(TEMPLATES_DIR, 'hello'), dst);

  // Customize template metadata, package, strings.xml & MainActivity.kt
  let pkgSeg = id.replace(/[^a-z0-9]/g, '');
  if (!pkgSeg || /^[0-9]/.test(pkgSeg)) pkgSeg = 'app' + pkgSeg;
  const appId = 'com.example.' + pkgSeg;

  const metaPath = path.join(dst, 'code-droid.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.appName = cleanName;
      meta.applicationId = appId;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    } catch { /* keep template default */ }
  }

  const stringsPath = path.join(dst, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  if (fs.existsSync(stringsPath)) {
    const xml = fs.readFileSync(stringsPath, 'utf8')
      .replace(/<string name="app_name">[\s\S]*?<\/string>/, `<string name="app_name">${escapeAndroidXmlString(cleanName)}</string>`);
    fs.writeFileSync(stringsPath, xml);
  }

  const manifestPath = path.join(dst, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (fs.existsSync(manifestPath)) {
    const mf = fs.readFileSync(manifestPath, 'utf8')
      .replace(/package="com\.example\.hellodroid"/, `package="${appId}"`);
    fs.writeFileSync(manifestPath, mf);
  }

  const oldKtDir = path.join(dst, 'app', 'src', 'main', 'java', 'com', 'example', 'hellodroid');
  const oldKt = path.join(oldKtDir, 'MainActivity.kt');
  if (fs.existsSync(oldKt)) {
    const kt = fs.readFileSync(oldKt, 'utf8')
      .replace(/^package\s+com\.example\.hellodroid\b/m, `package ${appId}`);
    if (pkgSeg !== 'hellodroid') {
      const newKtDir = path.join(dst, 'app', 'src', 'main', 'java', 'com', 'example', pkgSeg);
      fs.mkdirSync(newKtDir, { recursive: true });
      fs.writeFileSync(path.join(newKtDir, 'MainActivity.kt'), kt);
      fs.rmSync(oldKtDir, { recursive: true, force: true });
    } else {
      fs.writeFileSync(oldKt, kt);
    }
  }

  invalidate(id);
  return { id, name: cleanName };
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
  if (entries.some((e) => e.isSymbolicLink())) throw new Error('unsafe symbolic link in archive');
  let src = tmpUnpackedDir;
  if (entries.length === 1 && entries[0].isDirectory()) src = path.join(tmpUnpackedDir, entries[0].name);
  const id = uniqueProjectId(wantedName || entries[0]?.name || 'imported');
  const dst = path.join(PROJECTS_DIR, id);
  try {
    copyDir(src, dst, { rejectSymlinks: true });
  } catch (e) {
    fs.rmSync(dst, { recursive: true, force: true });
    throw e;
  }
  invalidate(id);
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
  init, listProjects, fileTree, readFile, readRawFile, writeFile, create, remove, rename,
  createProject, apkPath, projectRoot, search, importDir, uniqueProjectId,
};
