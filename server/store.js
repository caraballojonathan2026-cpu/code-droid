/*
 * store.js — project & file management with path-traversal protection.
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
  // Seed the hello-droid sample project on first run.
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
      else out.push({ name: e.name, path: rel, type: 'file' });
    }
    return out;
  }
  return node(root, '');
}

function readFile(project, rel) {
  return fs.readFileSync(resolveIn(project, rel), 'utf8');
}

function writeFile(project, rel, content) {
  const p = resolveIn(project, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
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

function apkPath(project) {
  const p = path.join(projectRoot(project), 'build', 'app-debug.apk');
  return fs.existsSync(p) ? p : null;
}

module.exports = { init, listProjects, fileTree, readFile, writeFile, create, remove, createProject, apkPath, projectRoot };
