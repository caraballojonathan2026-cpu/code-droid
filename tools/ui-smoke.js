#!/usr/bin/env node
/*
 * ui-smoke.js — headless smoke test for the web IDE (no browser needed).
 *
 * Stubs a minimal DOM + localStorage + fetch (served by the REAL project
 * store), loads web/kotlin.js and web/app.js exactly like the browser does,
 * lets the boot sequence run, and asserts:
 *
 *   ✔ no uncaught errors during startup
 *   ✔ the file tree is actually rendered (the v0.3.0 regression!)
 *   ✔ clicking a file in the tree opens it in the editor
 *
 *   node tools/ui-smoke.js     (or: npm run smoke)
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const store = require('../server/store');

let failures = 0;
const ok = (cond, label) => { console.log((cond ? '  ✔ ' : '  ✖ ') + label); if (!cond) failures++; };

const crashes = [];
process.on('unhandledRejection', (e) => crashes.push(e && e.message || String(e)));
process.on('uncaughtException', (e) => crashes.push(e && e.message || String(e)));

/* ---------------- minimal DOM ---------------- */
function makeEl(tag = 'div') {
  const listeners = new Map();
  const el = {
    tag,
    children: [],
    style: {},
    dataset: {},
    _html: '',
    textContent: '',
    value: '',
    title: '',
    disabled: false,
    readOnly: false,
    className: '',
    scrollTop: 0,
    scrollLeft: 0,
    clientHeight: 600,
    selectionStart: 0,
    selectionEnd: 0,
    parentElement: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { el.children.push(c); c.parentElement = el; return c; },
    insertBefore(c) { el.children.push(c); c.parentElement = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() {
      if (el.parentElement) {
        const i = el.parentElement.children.indexOf(el);
        if (i >= 0) el.parentElement.children.splice(i, 1);
      }
    },
    getBoundingClientRect() { return { width: 180, height: 100 }; },
    closest(sel) {
      let cur = el;
      while (cur) {
        if (sel.startsWith('.') && (cur.className.split(/\s+/).includes(sel.slice(1)) || cur.classList.contains(sel.slice(1)))) return cur;
        if (sel.startsWith('#') && cur._id === sel.slice(1)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector() { return makeEl(); }, // fresh stub; app only sets props on it
    querySelectorAll() { return []; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { if (listeners.has(type)) listeners.set(type, listeners.get(type).filter((f) => f !== fn)); },
    dispatchEvent(ev) {
      ev.target = ev.target || el;
      ev.preventDefault = ev.preventDefault || (() => {});
      for (const fn of (listeners.get(ev.type) || [])) fn(ev);
    },
    insertAdjacentHTML() {},
    scrollIntoView() {},
    focus() {},
    select() {},
    click() { if (typeof el.onclick === 'function') el.onclick({ stopPropagation() {}, preventDefault() {} }); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; if (v === '') el.children.length = 0; },
  });
  return el;
}

const byId = new Map();
const el = (id) => { if (!byId.has(id)) { const m = makeEl(); m._id = id; byId.set(id, m); } return byId.get(id); };
const docListeners = new Map();

global.innerWidth = 1280;
global.innerHeight = 800;
global.window = globalThis;
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.document = {
  getElementById: el,
  createElement: (t) => makeEl(t),
  addEventListener(type, fn) { if (!docListeners.has(type)) docListeners.set(type, []); docListeners.get(type).push(fn); },
  dispatchEvent(ev) {
    ev.preventDefault = ev.preventDefault || (() => {});
    for (const fn of (docListeners.get(ev.type) || [])) fn(ev);
  },
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  body: makeEl('body'),
};
global.getComputedStyle = () => ({ lineHeight: '19.575px' });
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
global.location = { href: '', reload() {} };
global.confirm = () => true;
global.prompt = () => null;
global.alert = () => {};
global.Event = class Event { constructor(type) { this.type = type; } };

const lsStore = new Map();
global.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
};

/* ---------------- fetch backed by an isolated temp copy of the store ---------------- */
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const gitMod = require('../server/git');

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-smoke-'));
const smokeRepoRoot = path.join(smokeRoot, 'build', 'repo'); // intentionally inside a 'build/' parent dir!
const smokeProjectsDir = path.join(smokeRepoRoot, 'projects');
store.init({ projectsDir: smokeProjectsDir, templatesDir: path.join(ROOT, 'templates') });

let fetchCalls = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url), 'http://smoke');
  const q = u.searchParams;
  fetchCalls.push({ method: opts.method || 'GET', path: u.pathname });
  let data;
  if (u.pathname === '/api/health') data = { ok: true, version: '0.4.2' };
  else if (u.pathname === '/api/tools') data = { ready: true, missing: [], tools: {} };
  else if (u.pathname === '/api/projects') data = { projects: store.listProjects() };
  else if (u.pathname === '/api/files') data = store.fileTree(q.get('project'));
  else if (u.pathname === '/api/file' && (!opts.method || opts.method === 'GET')) data = store.readFile(q.get('project'), q.get('path'));
  else if (u.pathname === '/api/file' && opts.method === 'POST') {
    const b = JSON.parse(opts.body);
    data = { saved: b.path, mtime: store.writeFile(b.project, b.path, b.content) };
  } else if (u.pathname === '/api/git/status') {
    data = gitMod.status(smokeRepoRoot, q.get('project'));
  } else throw new Error('ui-smoke: unstubbed endpoint ' + u.pathname);
  return { ok: true, status: 200, json: async () => data };
};

const flush = (ms = 200) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('code-droid UI & backend smoke test\n==================================\n');

  require('../web/kotlin.js');
  require('../web/app.js');
  await flush(); // let boot() finish (project load + tree render + rAFs)

  console.log('[1/8] startup');
  ok(crashes.length === 0, 'no uncaught errors during boot' + (crashes.length ? ' — ' + crashes.join(' | ') : ''));

  console.log('\n[2/8] file tree renders');
  const treeHost = byId.get('file-tree');
  ok(treeHost && treeHost.children.length >= 1, `explorer has content (${treeHost ? treeHost.children.length : 0} top rows)`);
  const rootUl = treeHost && treeHost.children.find((c) => c.tag === 'ul');
  ok(rootUl && rootUl.children.length >= 1, `project files listed (${rootUl ? rootUl.children.length : 0} items at root)`);

  // ---------- [3/8] opening files from the tree ----------
  console.log('\n[3/8] opening files from the tree');
  function findItem(root, suffix) {
    let found = null;
    (function rec(n) {
      if (found || !n || !n.children) return;
      for (const c of n.children) {
        if (!c) continue;
        const item = c.children && c.children[0];
        if (item && item.dataset && String(item.dataset.path || '').endsWith(suffix)) { found = item; return; }
        rec(c);
      }
    })(root);
    return found;
  }
  try {
    let item = findItem(treeHost, 'MainActivity.kt');
    if (!item) {
      const lis = [];
      (function rec(n) { (n.children || []).forEach((c) => { if (c && c.tag === 'li') { lis.push(c); rec(c); } }); })(treeHost);
      for (const li of lis) {
        const it = li.children && li.children[0];
        if (!it || typeof it.onclick !== 'function') continue;
        if (li.children.find((x) => x && x.tag === 'ul')) continue;
        try { await it.onclick(); } catch {}
      }
      await flush();
      item = findItem(treeHost, 'MainActivity.kt');
    }
    ok(!!item, 'MainActivity.kt reachable in the explorer (even inside a host path containing /build/)');
    if (item) {
      await item.onclick();
      await flush(80);
      ok(String(el('editor').value).includes('class MainActivity'), 'MainActivity.kt opened in the editor');
      ok((byId.get('tabs') ? byId.get('tabs').children.length : 0) >= 1, 'a tab is shown for the open file');
    }
  } catch (e) {
    ok(false, 'tree navigation threw: ' + e.message);
  }

  // ---------- [4/8] XML & Kotlin syntax highlighter ----------
  console.log('\n[4/8] syntax highlighter integrity');
  const sampleXml = `<?xml version="1.0"?>\n<manifest package="com.example.app" android:label="A > B">\n  <!-- <activity android:name=".Fake" /> -->\n</manifest>\n`;
  const xmlHtml = global.CDHighlight('AndroidManifest.xml', sampleXml);
  ok(!xmlHtml.includes('<span <span'), 'XML highlighter never corrupts its own <span> attributes');
  const unescapedXml = xmlHtml.replace(/<span class="tok-\w+">|<\/span>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  ok(unescapedXml === sampleXml + ' ', 'XML highlighter preserves exact characters + trailing newline space');

  // ---------- [5/8] tab context menu (dataset.path, Close Others, Close) ----------
  console.log('\n[5/8] tab context menu');
  const mfItem = findItem(treeHost, 'AndroidManifest.xml');
  if (mfItem) { await mfItem.onclick(); await flush(80); }
  const tabsEl = byId.get('tabs');
  ok(tabsEl.children.length === 2, 'two tabs open (MainActivity.kt + AndroidManifest.xml)');
  const firstTab = tabsEl.children[0];
  const secondTab = tabsEl.children[1];
  ok(Boolean(firstTab && firstTab.dataset.path && firstTab.dataset.path.endsWith('MainActivity.kt')), 'tab.dataset.path is populated');
  // Right-click secondTab -> Close Others
  global.document.dispatchEvent({ type: 'contextmenu', target: secondTab, clientX: 50, clientY: 50 });
  const ctxMenu = byId.get('ctx-menu');
  const closeOthersRow = ctxMenu.children.find((r) => (r._html || '').includes('Close Others'));
  ok(!!closeOthersRow, 'tab right-click menu renders Close Others');
  if (closeOthersRow) { closeOthersRow.click(); await flush(80); }
  ok(tabsEl.children.length === 1 && tabsEl.children[0].dataset.path.endsWith('AndroidManifest.xml'), 'Close Others keeps clicked tab and closes the rest');

  // ---------- [6/8] commit dialog saves dirty open tabs first ----------
  console.log('\n[6/8] commit dialog with unsaved edits');
  gitMod.commit(smokeRepoRoot, 'hello-droid', 'initial commit', '');
  el('editor').value += '\n<!-- unsaved edit in tab -->\n';
  el('editor').dispatchEvent(new global.Event('input'));
  fetchCalls = [];
  await el('btn-commit').onclick();
  await flush(80);
  const saveIdx = fetchCalls.findIndex((c) => c.method === 'POST' && c.path === '/api/file');
  const statusIdx = fetchCalls.findIndex((c) => c.method === 'GET' && c.path === '/api/git/status');
  ok(saveIdx !== -1 && statusIdx !== -1 && saveIdx < statusIdx, 'openCommit() saves dirty tabs before querying /api/git/status');
  el('commit-msg').value = 'update manifest';
  el('commit-msg').dispatchEvent(new global.Event('input'));
  ok(el('btn-do-commit').disabled === false, 'Commit button enables when dirty tab changes were auto-saved');

  // ---------- [7/8] store & git isolation regressions ----------
  console.log('\n[7/8] store & git regressions');
  const created = store.createProject('My Notes App');
  const listed = store.listProjects().find((p) => p.id === created.id);
  ok(listed && listed.name === 'My Notes App', 'createProject sets custom appName in code-droid.json');
  const newMf = store.readFile(created.id, 'app/src/main/AndroidManifest.xml').content;
  const newKt = store.readFile(created.id, 'app/src/main/java/com/example/mynotesapp/MainActivity.kt').content;
  ok(newMf.includes('package="com.example.mynotesapp"') && newKt.includes('package com.example.mynotesapp'), 'createProject customizes package in Manifest and MainActivity.kt');

  let rootDeleteBlocked = false;
  try { store.remove(created.id, ''); } catch { rootDeleteBlocked = true; }
  ok(rootDeleteBlocked && fs.existsSync(store.projectRoot(created.id)), 'empty path delete is blocked (project root protected)');

  store.writeFile(created.id, 'app/src/main/java/com/example/build/Helper.kt', 'package com.example.build\n');
  ok(store.readFile(created.id, 'app/src/main/java/com/example/build/Helper.kt').content.includes('package com.example.build'), 'subpackage named build/ inside src is allowed');

  let topBuildBlocked = false;
  try { store.writeFile(created.id, 'build/evil.txt', 'x'); } catch { topBuildBlocked = true; }
  ok(topBuildBlocked, 'top-level project build/ remains write-protected');

  // Binary file protection + raw read
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0xff, 0xfe]);
  const rawDst = path.join(store.projectRoot(created.id), 'app/src/main/res/drawable');
  fs.mkdirSync(rawDst, { recursive: true });
  fs.writeFileSync(path.join(rawDst, 'icon.png'), pngBytes);
  let binBlocked = false;
  try { store.readFile(created.id, 'app/src/main/res/drawable/icon.png'); } catch { binBlocked = true; }
  const rawOut = store.readRawFile(created.id, 'app/src/main/res/drawable/icon.png');
  ok(binBlocked && Buffer.compare(rawOut.buf, pngBytes) === 0, 'binary files blocked from text corruption & readable intact via readRawFile');

  // Symlink rejection in importDir
  const symUnpack = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-sym-'));
  fs.symlinkSync('/etc/hosts', path.join(symUnpack, 'leak.txt'));
  let symBlocked = false;
  try { store.importDir(symUnpack, 'evil-sym'); } catch { symBlocked = true; }
  fs.rmSync(symUnpack, { recursive: true, force: true });
  ok(symBlocked, 'importDir rejects symbolic links in unpacked archives');

  // Git path-scoped commit
  const gitIso = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-git-'));
  fs.mkdirSync(path.join(gitIso, 'projects', 'p1'), { recursive: true });
  fs.mkdirSync(path.join(gitIso, 'projects', 'p2'), { recursive: true });
  fs.writeFileSync(path.join(gitIso, 'projects', 'p1', 'a.kt'), 'class A');
  fs.writeFileSync(path.join(gitIso, 'projects', 'p2', 'b.kt'), 'class B');
  execFileSync('git', ['init', '-b', 'main'], { cwd: gitIso });
  execFileSync('git', ['add', 'projects/p2/b.kt'], { cwd: gitIso }); // unrelated staged file!
  const gc = gitMod.commit(gitIso, 'p1', 'only p1', '');
  const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: gitIso, encoding: 'utf8' }).trim();
  fs.rmSync(gitIso, { recursive: true, force: true });
  ok(gc.ok && committedFiles === 'projects/p1/a.kt', 'git.commit scopes commits strictly to the target project');

  // ---------- [8/8] HTTP server security & endpoints ----------
  console.log('\n[8/8] HTTP server security & routing');
  // Restore real repo store before loading server.js so repo working tree stays clean
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  const { server } = require('../server/server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const httpReq = (reqPath, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    const evilApi = await httpReq('/api/projects', { Origin: 'https://evil.example.com' });
    ok(evilApi.status === 403 && !evilApi.headers['access-control-allow-origin'], 'untrusted Origin is blocked (403, no ACAO header)');

    const evilCsrf = await httpReq('/api/project/new', { 'Sec-Fetch-Site': 'cross-site' }, 'POST');
    ok(evilCsrf.status === 403, 'cross-site request without trusted Origin is blocked (403)');

    const goodCors = await httpReq('/api/health', { Origin: 'https://caraballojonathan2026-cpu.github.io' });
    ok(goodCors.status === 200 && goodCors.headers['access-control-allow-origin'] === 'https://caraballojonathan2026-cpu.github.io', 'official GitHub Pages Origin is allowed');

    const localCors = await httpReq('/api/health', { Origin: 'http://localhost:8080' });
    ok(localCors.status === 200 && localCors.headers['access-control-allow-origin'] === 'http://localhost:8080', 'localhost Origin is allowed');

    const travStatic = await httpReq('/..%2Fweb-secret/foo.txt');
    const travRel = await httpReq('/releases/..%2Freleases-secret/foo.apk');
    ok(travStatic.status === 403 && travRel.status === 403, 'prefix-collision path traversal (/../web-*, /releases/../releases-*) is blocked (403)');

    const rawHttp = await httpReq('/api/file/raw?project=hello-droid&path=app/src/main/AndroidManifest.xml');
    const diskBytes = fs.readFileSync(path.join(ROOT, 'projects/hello-droid/app/src/main/AndroidManifest.xml'));
    ok(rawHttp.status === 200 && Buffer.compare(rawHttp.body, diskBytes) === 0, '/api/file/raw serves exact raw bytes');
  } finally {
    await new Promise((r) => server.close(r));
  }

  ok(crashes.length === 0, 'zero uncaught errors overall' + (crashes.length ? ' — ' + crashes.join(' | ') : ''));

  console.log('\n==================================');
  if (failures) { console.log(`✖ SMOKE TEST FAILED (${failures})`); process.exit(1); }
  console.log('✔ ALL SMOKE & SECURITY CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('✖ UI SMOKE CRASHED:', e); process.exit(1); });
