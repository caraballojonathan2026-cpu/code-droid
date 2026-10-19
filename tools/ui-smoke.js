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
  const el = {
    tag,
    children: [],
    style: {},
    dataset: {},
    _html: '',
    textContent: '',
    value: '',
    title: '',
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
    remove() {},
    querySelector() { return makeEl(); }, // fresh stub; app only sets props on it
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    insertAdjacentHTML() {},
    scrollIntoView() {},
    focus() {},
    select() {},
    click() {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; if (v === '') el.children.length = 0; },
  });
  return el;
}

const byId = new Map();
const el = (id) => { if (!byId.has(id)) byId.set(id, makeEl()); return byId.get(id); };

global.window = globalThis;
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.document = {
  getElementById: el,
  createElement: (t) => makeEl(t),
  addEventListener() {},
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

/* ---------------- fetch backed by the REAL store ---------------- */
store.init({ projectsDir: path.join(ROOT, 'projects'), templatesDir: path.join(ROOT, 'templates') });
global.fetch = async (url) => {
  const u = new URL(String(url), 'http://smoke');
  const q = u.searchParams;
  let data;
  if (u.pathname === '/api/health') data = { ok: true };
  else if (u.pathname === '/api/tools') data = { ready: true, missing: [], tools: {} };
  else if (u.pathname === '/api/projects') data = { projects: store.listProjects() };
  else if (u.pathname === '/api/files') data = store.fileTree(q.get('project'));
  else if (u.pathname === '/api/file') data = store.readFile(q.get('project'), q.get('path'));
  else throw new Error('ui-smoke: unstubbed endpoint ' + u.pathname);
  return { ok: true, status: 200, json: async () => data };
};

const flush = (ms = 250) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('code-droid UI smoke test\n========================\n');

  require('../web/kotlin.js');
  require('../web/app.js');
  await flush(); // let boot() finish (project load + tree render + rAFs)

  console.log('[1/3] startup');
  ok(crashes.length === 0, 'no uncaught errors during boot' + (crashes.length ? ' — ' + crashes.join(' | ') : ''));

  console.log('\n[2/3] file tree renders');
  const treeHost = byId.get('file-tree');
  ok(treeHost && treeHost.children.length >= 1, `explorer has content (${treeHost ? treeHost.children.length : 0} top rows)`);
  const rootUl = treeHost && treeHost.children.find((c) => c.tag === 'ul');
  ok(rootUl && rootUl.children.length >= 1, `project files listed (${rootUl ? rootUl.children.length : 0} items at root)`);

  // ---------- [3/3] opening a file by clicking it in the tree ----------
  console.log('\n[3/3] opening a file from the tree');
  // find a .tree-item (div inside an li) by its dataset.path suffix
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
      // expand collapsed branches: click every tree item that has no <ul> sibling yet
      const lis = [];
      (function rec(n) { (n.children || []).forEach((c) => { if (c && c.tag === 'li') { lis.push(c); rec(c); } }); })(treeHost);
      for (const li of lis) {
        const it = li.children && li.children[0];
        if (!it || typeof it.onclick !== 'function') continue;
        if (li.children.find((x) => x && x.tag === 'ul')) continue; // already expanded
        try { await it.onclick(); } catch { /* files navigate; dirs expand */ }
      }
      await flush();
      item = findItem(treeHost, 'MainActivity.kt');
    }
    ok(!!item, 'MainActivity.kt reachable in the explorer');
    if (item) {
      await item.onclick();
      await flush();
      ok(String(el('editor').value).includes('class MainActivity'), 'MainActivity.kt opened in the editor');
      ok((byId.get('tabs') ? byId.get('tabs').children.length : 0) >= 1, 'a tab is shown for the open file');
    }
  } catch (e) {
    ok(false, 'tree navigation threw: ' + e.message);
  }
  ok(crashes.length === 0, 'zero uncaught errors overall' + (crashes.length ? ' — ' + crashes.join(' | ') : ''));

  console.log('\n========================');
  if (failures) { console.log(`✖ UI SMOKE FAILED (${failures})`); process.exit(1); }
  console.log('✔ UI SMOKE PASSED');
  process.exit(0);
})().catch((e) => { console.error('✖ UI SMOKE CRASHED:', e); process.exit(1); });
