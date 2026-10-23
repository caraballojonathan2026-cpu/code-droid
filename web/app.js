/*
 * code-droid web IDE — zero dependencies.
 *
 * v0.2: scales to big projects (viewport highlighting, lazy tree, quick-open,
 * project search, cached-dex builds), never loses work (localStorage drafts +
 * UI restore), and self-manages (import/export .zip, server restart).
 */
'use strict';

const $ = (id) => document.getElementById(id);
const BIG_FILE = 120000;     // >120KB => viewport highlighting mode
const READONLY_AT = 2 * 1024 * 1024; // >2MB => open read-only
const DRAFT_MAX = 1500000;   // don't persist mega-files to localStorage

const state = {
  project: null,
  tabs: new Map(),          // path -> tab
  active: null,
  expanded: new Set(),
  treeCache: { data: null, ts: 0 },
  lineH: 19.6,
  gutterN: 0,
  built: false,
  draftCtx: null,           // {path, mode, draft}
  renderQueued: false,
};

/* ---------------- tiny storage wrapper ---------------- */
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* quota — drafts are best-effort */ } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n > 1024 ? Math.round(n / 1024) + 'KB' : n + 'B';
const fmtTime = (t) => new Date(t).toLocaleTimeString();

/* ---------------- API ---------------- */
/* Static demo mode: when the IDE is served without its node server
 * (GitHub Pages, file://, sandboxed previews), /api/* 404s. Instead of
 * failing at boot, the IDE serves the bundled hello project from
 * web/static-files.json, persists edits in localStorage, and gives
 * server-only features (build, git, import/export, restart) a clear message. */
let CD_STATIC = false;
let API_BASE = ''; // '' = same origin; else e.g. http://localhost:3000 (a server on the user's own machine)
async function api(path, opts = {}) {
  if (CD_STATIC) return staticApi(path, opts);
  const res = await fetch(API_BASE + path, opts.body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body),
  } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.steps) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

const staticStore = {
  manifest: null, files: null,
  async load() {
    if (this.files) return this.files;
    const res = await fetch('static-files.json');
    if (!res.ok) throw new Error('static-files.json missing (HTTP ' + res.status + ')');
    this.manifest = await res.json();
    this.files = { ...this.manifest.files };
    let overlay = {};
    try { overlay = JSON.parse(localStorage.getItem('cd.static.overlay') || '{}'); } catch {}
    for (const [p, c] of Object.entries(overlay)) {
      if (c === null || c === undefined) delete this.files[p]; else this.files[p] = c;
    }
    return this.files;
  },
  persist() {
    const diff = {};
    for (const [p, c] of Object.entries(this.files)) if (this.manifest.files[p] !== c) diff[p] = c;
    for (const p of Object.keys(this.manifest.files)) if (!(p in this.files)) diff[p] = null;
    try { localStorage.setItem('cd.static.overlay', JSON.stringify(diff)); } catch { /* quota — best effort */ }
  },
};

function staticTree(files) {
  const root = {};
  for (const fp of Object.keys(files)) {
    const parts = fp.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const key = parts.slice(0, i + 1).join('/');
      node[key] = node[key] || { name: parts[i], path: key, type: last ? 'file' : 'dir', children: {} };
      if (last) node[key].size = files[fp].length;
      node = node[key].children;
    }
  }
  const conv = (n) => Object.values(n)
    .map((c) => c.type === 'dir'
      ? { name: c.name, path: c.path, type: 'dir', children: conv(c.children) }
      : { name: c.name, path: c.path, type: 'file', size: c.size })
    .sort((a, b) => ((b.type === 'dir') - (a.type === 'dir')) || a.name.localeCompare(b.name));
  return conv(root);
}

async function staticApi(path, opts = {}) {
  const u = new URL(path, location.href);
  const p = u.pathname, q = u.searchParams, body = opts.body || {};
  const norm = (s) => String(s || '').replace(/^\/+|\/+$/g, '');
  const noServer = (what) => { throw new Error(what + ' needs the code-droid server.\nRun it locally:  node server/server.js'); };
  const files = await staticStore.load();
  const proj = staticStore.manifest.project;

  if (p === '/api/projects') return { projects: [{ id: proj.id, name: proj.name }] };
  if (p === '/api/tools') return { ready: false, missing: [], static: true };
  if (p === '/api/files') {
    const tree = staticTree(files);
    return { tree, truncated: false, nodeCount: Object.keys(files).length };
  }
  if (p === '/api/file' && !opts.body) {
    const rel = norm(q.get('path'));
    if (!(rel in files)) throw new Error('HTTP 404');
    return { path: rel, content: files[rel], mtime: Date.now(), size: files[rel].length };
  }
  if (p === '/api/file' && opts.body) {
    const rel = norm(body.path);
    files[rel] = String(body.content ?? '');
    staticStore.persist();
    return { saved: rel, mtime: Date.now() };
  }
  if (p === '/api/file/new') {
    let rel = norm(body.path);
    if (body.type === 'dir') rel = rel + '/.keep';
    if (!(rel in files)) files[rel] = '';
    staticStore.persist();
    return { created: body.path };
  }
  if (p === '/api/file/delete') {
    const rel = norm(body.path);
    for (const k of Object.keys(files)) if (k === rel || k.startsWith(rel + '/')) delete files[k];
    staticStore.persist();
    return { deleted: body.path };
  }
  if (p === '/api/file/rename') {
    const rel = norm(body.path), np = norm(body.newPath);
    for (const k of Object.keys(files)) {
      if (k === rel || k.startsWith(rel + '/')) { files[np + k.slice(rel.length)] = files[k]; delete files[k]; }
    }
    staticStore.persist();
    return { renamed: body.path, to: body.newPath };
  }
  if (p === '/api/search') {
    const needle = q.get('q') || '', ci = q.get('ci') !== '0';
    const ndl = ci ? needle.toLowerCase() : needle;
    const results = [];
    for (const [fp, content] of Object.entries(files)) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < 100; i++) {
        const hay = ci ? lines[i].toLowerCase() : lines[i];
        if (hay.includes(ndl)) results.push({ file: fp, line: i + 1, preview: lines[i].slice(0, 200) });
      }
    }
    return { results, truncated: results.length >= 100 };
  }
  if (p === '/api/build') return noServer('Building APKs');
  if (p === '/api/project/new') return noServer('Creating projects');
  if (p === '/api/git/status') return noServer('Git status');
  if (p === '/api/git/commit') return noServer('Committing');
  return noServer('This feature');
}

/* ---------------- console ---------------- */
function log(html, cls = '') {
  const con = $('console');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.innerHTML = html;
  con.appendChild(div);
  con.scrollTop = con.scrollHeight;
  $('console-pane').classList.remove('collapsed');
}

/* ---------------- tools status ---------------- */
async function checkTools() {
  const badge = $('tool-status');
  try {
    const t = await api('/api/tools');
    if (t.static) {
      badge.textContent = '● static demo';
      badge.className = 'badge ready';
      badge.title = 'No server: browse & edit freely — APK builds need node server/server.js';
      badge.onclick = () => log('<span class="info">Static demo mode (no server).\nEditing works and stays in this browser.\nFor APK builds, run the project locally: <b>node server/server.js</b></span>');
      return;
    }
    if (t.ready) {
      badge.textContent = '● toolchain ready';
      badge.className = 'badge ready';
      badge.title = 'aapt2, kotlinc, d8, zipalign, apksigner found';
      badge.onclick = null;
    } else {
      badge.textContent = '⚠ toolchain incomplete';
      badge.className = 'badge missing';
      badge.title = 'Missing: ' + t.missing.join(', ') + ' — click for fix';
      badge.onclick = () => {
        log('<span class="err">Toolchain incomplete — missing: <b>' + esc(t.missing.join(', ')) + '</b></span>');
        log('<span class="info">Run inside the code-droid folder, then press ⟳ to restart the server:\n\n  bash tools/install.sh\n\nOne-time setup (~300MB).</span>');
      };
    }
  } catch (e) {
    badge.textContent = '? tools unknown';
    badge.className = 'badge unknown';
  }
}

/* ---------------- projects & lazy file tree ---------------- */
async function loadProjects(selectId) {
  // show the running version next to the logo so it's obvious which build you're on
  api('/api/health').then((h) => { if (h && h.version) $('brand-ver').textContent = 'v' + h.version; }).catch(() => {});
  const { projects } = await api('/api/projects');
  const sel = $('project-select');
  sel.innerHTML = '';
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = '📦 ' + p.name;
    sel.appendChild(o);
  }
  const wanted = selectId && projects.some((p) => p.id === selectId) ? selectId : (projects[0] && projects[0].id);
  state.project = wanted;
  if (wanted) sel.value = wanted;
  state.treeCache = { data: null, ts: 0 };
  await refreshTree();
}

async function refreshTree() {
  if (!state.project) return;
  const data = await api('/api/files?project=' + encodeURIComponent(state.project));
  state.treeCache = { data: data.tree, ts: Date.now(), truncated: data.truncated, nodeCount: data.nodeCount };
  state.dirPages = new Map();
  if (!ls.get(`cd.expanded::${state.project}`)) {
    // first sight of this project: small projects open fully, big ones to depth 3
    const dirs = [];
    (function collect(ns, depth) { for (const n of ns) if (n.type === 'dir') { dirs.push({ p: n.path, d: depth }); collect(n.children || [], depth + 1); } })(state.treeCache.data, 1);
    state.expanded = new Set(dirs.length <= 60 ? dirs.map((x) => x.p) : dirs.filter((x) => x.d <= 3).map((x) => x.p));
  } else {
    try { state.expanded = new Set(JSON.parse(ls.get(`cd.expanded::${state.project}`) || '[]')); } catch { state.expanded = new Set(); }
  }
  renderTree();
}

const ICONS = { kt: '<span style="color:#7f52ff">K</span>', java: '<span style="color:#b07219">J</span>', xml: '<span style="color:#e8bf6a">◈</span>', json: '{ }', md: 'Ⓜ', default: '·' };
const iconFor = (name) => ICONS[name.split('.').pop().toLowerCase()] || ICONS.default;

function renderTree() {
  const host = $('file-tree');
  host.innerHTML = '';
  if (!state.treeCache.data) { host.textContent = '(loading…)'; return; }
  // VS Code style: the project itself is the collapsible root row
  const rootOpen = !state.expanded.has('__root__');
  const root = document.createElement('div');
  root.className = 'tree-item tree-root';
  root.innerHTML = `<span class="ico">${rootOpen ? '▾' : '▸'}</span><span class="name">📦 ${esc(state.project)}</span>`;
  root.title = state.project;
  root.dataset.type = 'root';
  root.onclick = () => {
    if (rootOpen) state.expanded.add('__root__'); else state.expanded.delete('__root__');
    persistUI(); renderTree();
  };
  host.appendChild(root);
  if (rootOpen) {
    host.appendChild(renderNodes(state.treeCache.data, 'root'));
    if (state.treeCache.truncated) {
      const note = document.createElement('div');
      note.className = 'tree-note';
      note.textContent = `⚠ explorer truncated at ${state.treeCache.nodeCount.toLocaleString()} items — use Ctrl+P / Ctrl+Shift+F`;
      host.appendChild(note);
    }
  }
}

const DIR_PAGE = 200; // files per folder rendered at a time ("… N more" paging)

function renderNodes(nodes, key) {
  const ul = document.createElement('ul');
  const shown = (state.dirPages && state.dirPages.get(key)) || DIR_PAGE;
  const slice = nodes.length > shown ? nodes.slice(0, shown) : nodes;
  for (const n of slice) {
    const li = document.createElement('li');
    const isDir = n.type === 'dir';
    if (isDir) li.className = 'tree-dir';
    const item = document.createElement('div');
    item.className = 'tree-item' + (state.active === n.path ? ' active' : '');
    item.innerHTML = `<span class="ico">${isDir ? (state.expanded.has(n.path) ? '▾' : '▸') : iconFor(n.name)}</span><span class="name">${esc(n.name)}</span>`;
    item.title = n.path + (!isDir && n.size != null ? `  ·  ${fmtSize(n.size)}` : '');
    item.dataset.path = n.path;
    item.dataset.type = isDir ? 'dir' : 'file';
    if (isDir) {
      item.onclick = () => {
        const open = state.expanded.has(n.path);
        const sub = li.querySelector(':scope > ul');
        if (open) { state.expanded.delete(n.path); if (sub) sub.remove(); item.querySelector('.ico').textContent = '▸'; }
        else { state.expanded.add(n.path); li.appendChild(renderNodes(n.children || [], n.path)); item.querySelector('.ico').textContent = '▾'; }
        persistUI();
      };
      li.appendChild(item);
      if (state.expanded.has(n.path)) li.appendChild(renderNodes(n.children || [], n.path));
    } else {
      item.onclick = () => openFile(n.path);
      li.appendChild(item);
    }
    ul.appendChild(li);
  }
  if (nodes.length > shown) {
    const more = document.createElement('li');
    const item = document.createElement('div');
    item.className = 'tree-item tree-more';
    item.innerHTML = `<span class="ico">…</span><span class="name">${(nodes.length - shown).toLocaleString()} more — click to load</span>`;
    item.onclick = () => {
      state.dirPages.set(key, shown + DIR_PAGE * 5);
      renderTree();
    };
    more.appendChild(item);
    ul.appendChild(more);
  }
  return ul;
}

/* ---------------- drafts (localStorage) ---------------- */
const draftKey = (p) => `cd.draft::${state.project}::${p}`;
function saveDraft(p, content, mtime) {
  if (content.length > DRAFT_MAX) return;
  ls.set(draftKey(p), JSON.stringify({ c: content, m: mtime, t: Date.now() }));
}
function loadDraft(p) {
  try { return JSON.parse(ls.get(draftKey(p)) || 'null'); } catch { return null; }
}
function clearDraft(p) { ls.del(draftKey(p)); }

/* ---------------- editor ---------------- */
const editor = $('editor');
const gutter = $('gutter');
const gutterInner = $('gutter-inner');
const hlLayer = $('highlight-layer');
const hlCode = $('highlight-code');
const curTab = () => state.tabs.get(state.active);

function stashActive() {
  if (state.active && state.tabs.has(state.active) && !editor.readOnly) {
    state.tabs.get(state.active).content = editor.value;
  }
}

function requestRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; renderEditor(); });
}

function renderEditor() {
  const t = curTab();
  if (!t) return;
  const src = editor.value;
  t.big = src.length > BIG_FILE;
  if (!t.big) {
    t.lines = null;
    hlCode.innerHTML = CDHighlight(state.active, src);
  } else {
    // viewport mode: escape everything, syntax-highlight only the visible window
    if (!t.lines) t.lines = src.split('\n');
    const total = t.lines.length;
    const first = Math.max(0, Math.floor(editor.scrollTop / state.lineH) - 150);
    const last = Math.min(total - 1, Math.ceil((editor.scrollTop + editor.clientHeight) / state.lineH) + 150);
    let html = '';
    if (first > 0) html += CDHighlight.esc(t.lines.slice(0, first).join('\n')) + '\n';
    html += CDHighlight(state.active, t.lines.slice(first, last + 1).join('\n'));
    if (last < total - 1) html += '\n' + CDHighlight.esc(t.lines.slice(last + 1).join('\n'));
    hlCode.innerHTML = html;
  }
  updateGutter(src);
  updateFileInfo(src);
}

/* ---------------- virtualized line-number gutter ----------------
 * Normal files (<4K lines): full number list, moved with a CSS transform.
 * Big files: only the visible window is rendered (like the syntax layer). */
const GUTTER_VIRTUAL_AT = 4000;
function updateGutter(src) {
  const t = curTab();
  if (!t) return;
  const total = t.big && t.lines ? t.lines.length : (src.match(/\n/g) || []).length + 1;
  const padTop = 10; // matches editor padding-top
  if (total <= GUTTER_VIRTUAL_AT) {
    if (state.gutterN !== total || state.gutterMode !== 'full') {
      const buf = new Array(total);
      for (let i = 0; i < total; i++) buf[i] = i + 1;
      gutterInner.textContent = buf.join('\n');
      state.gutterN = total; state.gutterMode = 'full'; state.gutterFirst = 0;
    }
    gutterInner.style.transform = `translateY(${padTop - editor.scrollTop}px)`;
  } else {
    const first = Math.max(0, Math.floor(editor.scrollTop / state.lineH) - 60);
    const last = Math.min(total - 1, Math.ceil((editor.scrollTop + editor.clientHeight) / state.lineH) + 60);
    if (state.gutterMode !== 'virt' || first !== state.gutterFirst || total !== state.gutterN || last > state.gutterLast) {
      const cnt = last - first + 1;
      const buf = new Array(cnt);
      for (let i = 0; i < cnt; i++) buf[i] = first + i + 1;
      gutterInner.textContent = buf.join('\n');
      state.gutterMode = 'virt'; state.gutterFirst = first; state.gutterN = total; state.gutterLast = last;
    }
    gutterInner.style.transform = `translateY(${padTop + state.gutterFirst * state.lineH - editor.scrollTop}px)`;
  }
}

function updateFileInfo(src) {
  $('file-info').textContent = `${state.gutterN.toLocaleString()} lines · ${fmtSize(src.length)}`;
}

function syncScroll() {
  hlLayer.scrollTop = editor.scrollTop;
  hlLayer.scrollLeft = editor.scrollLeft;
  const t = curTab();
  if (t) updateGutter(editor.value); // keep virtualized gutter aligned
  if (t && t.big) requestRender();   // re-highlight the new viewport
}

function updateCursor() {
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  const ln = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  $('cursor-pos').textContent = `Ln ${ln.toLocaleString()}, Col ${col}`;
}

function lineOffset(src, line) {
  let off = 0, l = 1;
  while (l < line) {
    const i = src.indexOf('\n', off);
    if (i === -1) break;
    off = i + 1; l++;
  }
  return off;
}

function gotoLine(line) {
  const off = lineOffset(editor.value, line);
  editor.focus();
  editor.selectionStart = editor.selectionEnd = off;
  editor.scrollTop = Math.max(0, (line - 8) * state.lineH);
  editor.scrollLeft = 0;
  syncScroll(); updateCursor(); requestRender();
}

editor.addEventListener('input', () => {
  const t = curTab();
  if (!t) return;
  t.content = editor.value;
  t.lines = null; // invalidate viewport cache
  t.dirty = editor.value !== t.saved;
  markTabDirty();
  requestRender();
  clearTimeout(t._draftTimer);
  t._draftTimer = setTimeout(() => { saveDraft(state.active, t.content, t.mtime); }, 400);
});
editor.addEventListener('scroll', syncScroll);
editor.addEventListener('keyup', updateCursor);
editor.addEventListener('click', updateCursor);
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); if (!editor.readOnly) insertAtCursor('    '); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
});
function insertAtCursor(text) {
  const s = editor.selectionStart, epos = editor.selectionEnd;
  editor.value = editor.value.slice(0, s) + text + editor.value.slice(epos);
  editor.selectionStart = editor.selectionEnd = s + text.length;
  editor.dispatchEvent(new Event('input'));
}

/* ---------------- draft banner ---------------- */
function showBanner(text, ctx) {
  state.draftCtx = ctx;
  $('draft-text').textContent = text;
  $('draft-banner').classList.remove('hidden');
  $('btn-draft-save').style.display = ctx.mode === 'restored' ? '' : 'none';
  const disc = $('btn-draft-discard');
  disc.textContent = ctx.mode === 'conflict' ? 'Discard draft' : 'Discard draft';
}
function hideBanner() { $('draft-banner').classList.add('hidden'); state.draftCtx = null; }
$('btn-draft-save').onclick = async () => { await saveActive(); hideBanner(); };
$('btn-draft-hide').onclick = hideBanner;
$('btn-draft-discard').onclick = () => {
  const ctx = state.draftCtx;
  if (ctx) {
    clearDraft(ctx.path);
    if (ctx.mode === 'conflict') { /* disk version stays */ }
    if (ctx.mode === 'restored' && state.active === ctx.path) {
      const t = curTab();
      t.content = t.saved; editor.value = t.saved; t.dirty = false;
      markTabDirty(); requestRender();
    }
  }
  hideBanner();
};
// "Use my draft" for conflicts reuses the save button area:
const useDraftBtn = document.createElement('button');
useDraftBtn.className = 'mini hidden';
useDraftBtn.textContent = '⬅ Use my draft';
$('draft-banner').insertBefore(useDraftBtn, $('btn-draft-discard'));
useDraftBtn.onclick = () => {
  const ctx = state.draftCtx;
  if (!ctx || !ctx.draft) return hideBanner();
  const t = curTab();
  t.content = ctx.draft.c; t.mtime = ctx.draft.m; editor.value = ctx.draft.c;
  t.dirty = true; t.lines = null;
  markTabDirty(); requestRender();
  showBanner(`Using your draft from ${fmtTime(ctx.draft.t)} — not saved to disk yet.`, { ...ctx, mode: 'restored' });
};

const origShowBanner = showBanner;
showBanner = function (text, ctx) {
  origShowBanner(text, ctx);
  useDraftBtn.classList.toggle('hidden', ctx.mode !== 'conflict');
};

/* ---------------- tabs & files ---------------- */
async function openFile(p, opts = {}) {
  if (!state.tabs.has(p)) {
    let f;
    try { f = await api(`/api/file?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(p)}`); }
    catch (e) { if (!opts.silent) log('<span class="err">' + esc(e.message) + '</span>'); return; }
    const t = { path: p, content: f.content, saved: f.content, mtime: f.mtime, dirty: false, big: false, lines: null, readonly: f.size > READONLY_AT };
    // draft recovery
    const d = loadDraft(p);
    if (d && d.c !== f.content) {
      if (d.m === f.mtime) {
        t.content = d.c; t.mtime = d.m; t.dirty = true;
        state._pendingBanner = { text: `✏ Restored unsaved changes from ${fmtTime(d.t)} (never saved to disk).`, ctx: { path: p, mode: 'restored', draft: d } };
      } else {
        state._pendingBanner = { text: `⚠ Disk version is newer than your draft from ${fmtTime(d.t)}. Disk version is shown.`, ctx: { path: p, mode: 'conflict', draft: d } };
      }
    }
    state.tabs.set(p, t);
  }
  if (state.active !== p) stashActive();
  state.active = p;
  const t = curTab();
  $('welcome').classList.add('hidden');
  $('editor-wrap').classList.remove('hidden');
  editor.readOnly = !!t.readonly;
  editor.value = t.content;
  hideBanner();
  if (state._pendingBanner) { showBanner(state._pendingBanner.text, state._pendingBanner.ctx); state._pendingBanner = null; }
  if (!state.lineH || state.lineH === 19.6) {
    state.lineH = parseFloat(getComputedStyle(editor).lineHeight) || 19.6;
  }
  renderTabs();
  markTabDirty();
  document.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'));
  const el = document.querySelector(`.tree-item[data-path="${CSS.escape(p)}"]`);
  if (el) el.classList.add('active');
  requestRender(); syncScroll(); updateCursor();
  if (opts.line) gotoLine(opts.line);
  persistUI();
}

async function openFileAt(p, line) { await openFile(p, { line }); }

function renderTabs() {
  const host = $('tabs');
  host.innerHTML = '';
  for (const [p, t] of state.tabs) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (p === state.active ? ' active' : '');
    tab.innerHTML = `${esc(p.split('/').pop())}${t.dirty ? '<span class="dot">●</span>' : ''}<span class="x">✕</span>`;
    tab.querySelector('.x').onclick = (ev) => { ev.stopPropagation(); closeTab(p); };
    tab.onclick = () => openFile(p);
    host.appendChild(tab);
  }
}

function markTabDirty() {
  const t = curTab();
  if (!t) { $('file-status').textContent = ''; return; }
  $('file-status').textContent =
    (t.readonly ? 'read-only (file > 2MB) · ' : '') + state.active + (t.dirty ? ' — unsaved (backed up in browser)' : '');
  $('file-status').className = t.dirty ? 'dirty' : '';
  renderTabs();
}

function closeTab(p) {
  const t = state.tabs.get(p);
  if (!t) return;
  if (t.dirty && !loadDraft(p) && t.content.length <= DRAFT_MAX) saveDraft(p, t.content, t.mtime); // close keeps a draft copy
  state.tabs.delete(p);
  if (state.active === p) {
    state.active = null;
    const rest = [...state.tabs.keys()];
    if (rest.length) openFile(rest[rest.length - 1]);
    else { $('editor-wrap').classList.add('hidden'); $('welcome').classList.remove('hidden'); hideBanner(); persistUI(); }
  }
  renderTabs(); persistUI();
}

/* ---------------- save ---------------- */
async function saveActive() {
  if (!state.active) return;
  const t = curTab();
  if (t.readonly) return;
  t.content = editor.value;
  const r = await api('/api/file', { body: { project: state.project, path: state.active, content: editor.value } });
  t.saved = editor.value; t.mtime = r.mtime; t.dirty = false;
  clearDraft(state.active);
  markTabDirty(); renderTabs();
}

async function saveAll() {
  for (const [p, t] of state.tabs) {
    if (!t.dirty || t.readonly) continue;
    if (p === state.active) t.content = editor.value;
    const r = await api('/api/file', { body: { project: state.project, path: p, content: t.content } });
    t.saved = t.content; t.mtime = r.mtime; t.dirty = false;
    clearDraft(p);
  }
  renderTabs(); markTabDirty();
}

/* ---------------- build ---------------- */
async function build() {
  const btn = $('btn-build');
  btn.disabled = true; btn.textContent = '⏳ Building…';
  state.built = false; $('btn-apk').classList.add('hidden');
  $('build-summary').textContent = '';
  try {
    await saveAll();
    log(`<span class="info">▶ Building <b>${esc(state.project)}</b> — direct pipeline (aapt2 → kotlinc → d8 → zipalign → apksigner), no Gradle.</span>`);
    const r = await api('/api/build', { body: { project: state.project } });
    for (const s of r.steps || []) {
      log(`<span class="step-head ${s.ok ? 'step-ok' : 'step-fail'}">${s.ok ? '✔' : '✖'} ${esc(s.name)} <small>(${s.ms}ms)</small></span>` + (s.log ? `<div class="step-log">${esc(s.log)}</div>` : ''));
    }
    if (r.ok) {
      state.built = true;
      const apkUrl = API_BASE + '/api/apk?project=' + encodeURIComponent(state.project);
      $('btn-apk').classList.remove('hidden');
      $('btn-apk').href = apkUrl;
      $('btn-apk').textContent = `⬇ APK (${r.sizeKB} KB)`;
      $('btn-apk').onclick = (e) => { e.preventDefault(); offerDownload(apkUrl, `${state.project}-debug.apk`); };
      $('build-summary').textContent = `✔ OK in ${(r.totalMs / 1000).toFixed(1)}s — ${r.sizeKB} KB`;
      log(`<span class="apk-line">✔ BUILD SUCCESSFUL in ${(r.totalMs / 1000).toFixed(1)}s — ${esc(r.apk)} (${r.sizeKB} KB)</span>`);
      if (r.release) log(`<span class="info">📦 Also saved to <b>${esc(r.release)}</b> — a plain visible file you can grab directly.</span>`);
      log(`<span class="info">Install on a real phone (no emulator!):\n  ${esc(r.install.adb)}\n${esc(r.install.manual)}</span>`);
    } else {
      $('build-summary').textContent = '✖ ' + (r.error || 'build failed');
      log(`<span class="err">✖ ${esc(r.error || 'BUILD FAILED')}</span>`);
      if (r.missing) log(`<span class="info">Missing tools: ${esc(r.missing.join(', '))}\nFix: bash tools/install.sh, then press ⟳.</span>`);
    }
  } catch (e) {
    $('build-summary').textContent = '✖ error';
    log(`<span class="err">✖ ${esc(e.message)}</span>`);
  } finally {
    btn.disabled = false; btn.innerHTML = '▶ Build APK';
  }
}

/* ---------------- quick open (Ctrl+P) ---------------- */
const qo = { open: false, items: [], sel: 0, flat: [] };
 function flattenTree(nodes, out = []) {
  for (const n of nodes) {
    if (n.type === 'file') out.push({ path: n.path, base: n.name });
    else flattenTree(n.children || [], out);
  }
  return out;
}
function qoScore(q, text) {
  // subsequence match; consecutive matches and basename hits score better
  let qi = 0, score = 0, last = -2;
  const s = text.toLowerCase();
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) { score += (i === last + 1 ? 3 : 1) + (q.length > 2 ? 1 : 0); last = i; qi++; }
  }
  return qi === q.length ? score - text.length * 0.01 : -1;
}
function qoRender() {
  const q = $('qo-input').value.trim().toLowerCase();
  let items = state.flatFiles || [];
  if (q) {
    items = items.map((f) => ({ ...f, s: Math.max(qoScore(q, f.base.toLowerCase()) * 2, qoScore(q, f.path.toLowerCase())) }))
      .filter((f) => f.s >= 0).sort((a, b) => b.s - a.s);
  }
  qo.items = items.slice(0, 60);
  qo.sel = 0;
  const list = $('qo-list');
  list.innerHTML = '';
  if (!qo.items.length) { list.innerHTML = '<div class="qo-empty">No matching files.</div>'; return; }
  qo.items.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'qo-item' + (i === qo.sel ? ' sel' : '');
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    div.innerHTML = `<span class="base">${esc(f.base)}</span><span class="dir">${esc(dir)}</span>`;
    div.onclick = () => qoPick(i);
    list.appendChild(div);
  });
}
function qoPick(i) {
  const f = qo.items[i ?? qo.sel];
  if (!f) return;
  qoClose();
  openFile(f.path);
}
function qoOpen() {
  state.flatFiles = flattenTree(state.treeCache.data || []);
  qo.open = true;
  $('quick-open').classList.remove('hidden');
  $('qo-input').value = '';
  qoRender();
  setTimeout(() => $('qo-input').focus(), 0);
}
function qoClose() { qo.open = false; $('quick-open').classList.add('hidden'); }
$('qo-input').addEventListener('input', qoRender);
$('qo-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') qoClose();
  else if (e.key === 'Enter') qoPick();
  else if (e.key === 'ArrowDown') { e.preventDefault(); qo.sel = Math.min(qo.sel + 1, qo.items.length - 1); qoHighlight(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); qo.sel = Math.max(qo.sel - 1, 0); qoHighlight(); }
});
function qoHighlight() {
  [...$('qo-list').children].forEach((el, i) => el.classList.toggle('sel', i === qo.sel));
  const sel = $('qo-list').children[qo.sel];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}
$('quick-open').onclick = (e) => { if (e.target.id === 'quick-open') qoClose(); };

/* ---------------- project search (Ctrl+Shift+F) ---------------- */
function openSearch() {
  $('searchbar').classList.remove('hidden');
  $('search-input').focus(); $('search-input').select();
}
function closeSearch() { $('searchbar').classList.add('hidden'); }
$('search-input').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') return closeSearch();
  if (e.key !== 'Enter') return;
  const q = $('search-input').value.trim();
  if (q.length < 2) return;
  closeSearch();
  try {
    const r = await api(`/api/search?project=${encodeURIComponent(state.project)}&q=${encodeURIComponent(q)}&ci=${$('search-ci').checked ? '1' : '0'}`);
    log(`<span class="info">🔎 “${esc(q)}” — ${r.results.length} result(s)${r.truncated ? ' (truncated)' : ''}:</span>`);
    for (const h of r.results) {
      const div = document.createElement('div');
      div.className = 'hit';
      const idx = $('search-ci').checked ? h.preview.toLowerCase().indexOf(q.toLowerCase()) : h.preview.indexOf(q);
      const marked = idx >= 0
        ? esc(h.preview.slice(0, idx)) + '<span class="mark">' + esc(h.preview.slice(idx, idx + q.length)) + '</span>' + esc(h.preview.slice(idx + q.length))
        : esc(h.preview);
      div.innerHTML = `<span class="loc">${esc(h.file)}:${h.line}</span>${marked}`;
      div.onclick = () => openFileAt(h.file, h.line);
      $('console').appendChild(div);
    }
    $('console').scrollTop = 0;
  } catch (err) { log('<span class="err">Search failed: ' + esc(err.message) + '</span>'); }
});

/* ---------------- new file / project ---------------- */
async function newFile() {
  if (!state.project) return;
  const p = prompt('New file path (relative to project), e.g.\napp/src/main/java/com/example/hellodroid/SecondActivity.kt');
  if (!p) return;
  try {
    await api('/api/file/new', { body: { project: state.project, path: p, type: p.endsWith('/') ? 'dir' : 'file' } });
    await refreshTree();
    if (!p.endsWith('/')) openFile(p);
  } catch (e) { alert(e.message); }
}
async function newProject() {
  const name = prompt('Name for the new project (created from the hello template):');
  if (!name) return;
  try {
    const { project } = await api('/api/project/new', { body: { name } });
    await loadProjects(project.id);
    log(`<span class="info">Created project <b>${esc(project.id)}</b> from template.</span>`);
  } catch (e) { alert(e.message); }
}

/* ---------------- import / export / restart ---------------- */
$('btn-export').onclick = () => {
  if (CD_STATIC) { log('<span class="info">Export needs the code-droid server (static demo mode).</span>'); return; }
  if (!state.project) return;
  saveAll().finally(() => {
    offerDownload(API_BASE + '/api/project/export?project=' + encodeURIComponent(state.project), state.project + '.zip');
  });
};
$('btn-import').onclick = () => $('import-file').click();
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (CD_STATIC) { log('<span class="err">Import needs the code-droid server (static demo mode).</span>'); return; }
  log(`<span class="info">⇧ Importing ${esc(f.name)} (${fmtSize(f.size)})…</span>`);
  try {
    const res = await fetch(API_BASE + '/api/project/import?name=' + encodeURIComponent(f.name.replace(/\.zip$/i, '')), {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: f,
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'import failed');
    log(`<span class="apk-line">✔ Imported as project <b>${esc(d.imported)}</b></span>`);
    await loadProjects(d.imported);
  } catch (err) { log('<span class="err">Import failed: ' + esc(err.message) + '</span>'); }
});

$('btn-restart').onclick = async () => {
  if (CD_STATIC) { log('<span class="info">⟳ No server to restart in static demo mode.</span>'); return; }
  if (!confirm('Restart the code-droid server?\n\nYour open tabs and unsaved work are backed up in this browser and will come back.')) return;
  stashActive();
  if (state.active && curTab().dirty) saveDraft(state.active, editor.value, curTab().mtime);
  persistUI();
  try { await fetch(API_BASE + '/api/restart', { method: 'POST' }); } catch { /* server already gone */ }
  log('<span class="info">⟳ Restarting server…</span>');
  let back = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const r = await fetch(API_BASE + '/api/health'); if (r.ok) { back = true; break; } } catch { /* down */ }
  }
  if (back) {
    log('<span class="step-ok">✔ Server is back — reloading the IDE (your work is restored from localStorage).</span>');
    setTimeout(() => location.reload(), 700);
  } else {
    log('<span class="err">Server did not come back. If it was started directly (node server/server.js),\nstart it again with: npm start  (uses launcher.js, which makes ⟳ work).</span>');
  }
};

/* ---------------- connect to a local server (🔌) ----------------
 * The hosted page (GitHub Pages) can drive a code-droid server running on
 * the user's own machine: builds compile there, APKs download here. */
$('btn-connect').onclick = async () => {
  const cur = ls.get('cd.server') || 'http://localhost:3000';
  const url = prompt('code-droid server URL — the machine that will compile\n(start it there first with:  node server/server.js)', cur);
  if (!url) return;
  const base = url.trim().replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/api/health', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    ls.set('cd.server', base);
    log('<span class="info">🔌 Server found at <b>' + esc(base) + '</b> — reloading connected…</span>');
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    log('<span class="err">Could not reach a code-droid server at ' + esc(base) + '.\nStart it on that machine with:  node server/server.js\n(the server needs code-droid 0.4.2+ for cross-origin access)</span>');
  }
};

/* ---------------- download helper (iframe-sandbox-proof) ----------------
 * Live-preview iframes often block <a download> silently. So the APK/Export
 * buttons open this panel with three ways out: programmatic download,
 * open-in-new-tab, and a copy-able absolute URL (which always works). */
const dl = { url: null, filename: null };
function offerDownload(url, filename) {
  dl.url = url; dl.filename = filename;
  $('dl-title').textContent = '⬇ ' + filename;
  $('dl-url').value = new URL(url, location.href).href;
  $('btn-dl-copy').textContent = '⧉ Copy';
  $('dl-modal').classList.remove('hidden');
}
$('btn-close-dl').onclick = () => $('dl-modal').classList.add('hidden');
$('dl-modal').onclick = (e) => { if (e.target.id === 'dl-modal') $('dl-modal').classList.add('hidden'); };
$('btn-dl-direct').onclick = async () => {
  try {
    const res = await fetch(dl.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = dl.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    log('<span class="err">Download failed: ' + esc(e.message) + ' — copy the link and paste it in a new tab.</span>');
  }
};
$('btn-dl-newtab').onclick = () => {
  try { window.open(dl.url, '_blank'); }
  catch { location.href = dl.url; }
};
$('btn-dl-copy').onclick = async () => {
  const done = (msg) => { $('btn-dl-copy').textContent = msg; setTimeout(() => { $('btn-dl-copy').textContent = '⧉ Copy'; }, 1500); };
  try { $('dl-url').select(); } catch { /* ignore */ }
  try { await navigator.clipboard.writeText($('dl-url').value); done('✔ Copied'); }
  catch { try { document.execCommand('copy'); done('✔ Copied'); } catch { done('press Ctrl+C'); } }
};

/* ---------------- context menus (right-click) ---------------- */
const ctx = $('ctx-menu');

function showCtxMenu(x, y, items) {
  ctx.innerHTML = '';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; ctx.appendChild(s); continue; }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    row.innerHTML = `<span>${esc(it.label)}</span>${it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : ''}`;
    if (!it.disabled) row.onclick = () => { hideCtxMenu(); it.action(); };
    ctx.appendChild(row);
  }
  ctx.classList.remove('hidden');
  const r = ctx.getBoundingClientRect(); // keep the menu inside the viewport
  if (x + r.width > innerWidth) x = innerWidth - r.width - 6;
  if (y + r.height > innerHeight) y = innerHeight - r.height - 6;
  ctx.style.left = x + 'px';
  ctx.style.top = y + 'px';
}
function hideCtxMenu() { ctx.classList.add('hidden'); }
document.addEventListener('click', hideCtxMenu, true);
window.addEventListener('blur', hideCtxMenu);
editor.addEventListener('scroll', hideCtxMenu);

document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('#file-tree')) { e.preventDefault(); treeCtx(e); }
  else if (e.target.closest('#editor')) { e.preventDefault(); editorCtx(e); }
  else if (e.target.closest('.tab')) { e.preventDefault(); tabCtx(e, e.target.closest('.tab')); }
});

function treeCtx(e) {
  if (!state.project) return;
  const item = e.target.closest('.tree-item');
  const x = e.clientX, y = e.clientY;
  if (item && item.dataset.type === 'dir') {
    const dir = item.dataset.path;
    showCtxMenu(x, y, [
      { label: '＋ New File here…', action: () => newFileAt(dir, 'file') },
      { label: '＋ New Folder here…', action: () => newFileAt(dir, 'dir') },
      { sep: true },
      { label: 'Rename folder…', action: () => renamePath(dir) },
      { label: 'Delete folder', danger: true, action: () => deletePath(dir, true) },
      { sep: true },
      { label: 'Refresh explorer', action: refreshTree },
    ]);
  } else if (item && item.dataset.type === 'file') {
    const p = item.dataset.path;
    showCtxMenu(x, y, [
      { label: 'Open', hint: 'click', action: () => openFile(p) },
      { sep: true },
      { label: 'Download this file', action: () => downloadFile(p) },
      { label: 'Rename…', action: () => renamePath(p) },
      { label: 'Delete', danger: true, action: () => deletePath(p, false) },
    ]);
  } else {
    showCtxMenu(x, y, [
      { label: '＋ New File…', action: newFile },
      { label: '＋ New Folder…', action: newFolderRoot },
      { label: '＋ New Project…', action: newProject },
      { sep: true },
      { label: 'Refresh explorer', action: refreshTree },
    ]);
  }
}

function editorCtx(e) {
  const t = curTab();
  if (!t) return;
  const hasSel = editor.selectionStart !== editor.selectionEnd;
  showCtxMenu(e.clientX, e.clientY, [
    { label: 'Save', hint: 'Ctrl+S', disabled: t.readonly, action: saveActive },
    { sep: true },
    { label: 'Cut', hint: 'Ctrl+X', disabled: !hasSel || t.readonly, action: () => { editor.focus(); try { document.execCommand('cut'); } catch { insertAtCursor(''); } } },
    { label: 'Copy', hint: 'Ctrl+C', disabled: !hasSel, action: () => { editor.focus(); try { document.execCommand('copy'); } catch { /* Ctrl+C works anyway */ } } },
    { label: 'Paste', hint: 'Ctrl+V', disabled: t.readonly, action: pasteFromClipboard },
    { label: 'Select All', hint: 'Ctrl+A', action: () => { editor.focus(); editor.select(); } },
    { sep: true },
    { label: 'Go to Line…', action: () => { const n = prompt(`Line (1–${state.gutterN.toLocaleString()}):`); if (n) gotoLine(Math.max(1, Math.min(parseInt(n, 10) || 1, state.gutterN))); } },
    { label: '▶ Build APK', disabled: t.readonly, action: build },
  ]);
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { editor.focus(); insertAtCursor(text); }
  } catch {
    log('<span class="info">Clipboard paste needs browser permission — press Ctrl+V inside the editor instead.</span>');
  }
}

function tabCtx(e, tab) {
  const p = tab.dataset.path;
  showCtxMenu(e.clientX, e.clientY, [
    { label: 'Close', danger: true, action: () => closeTab(p) },
    { label: 'Close Others', action: () => {
      for (const k of [...state.tabs.keys()]) if (k !== p) state.tabs.delete(k);
      if (state.tabs.has(p)) openFile(p);
      else { state.active = null; $('editor-wrap').classList.add('hidden'); $('welcome').classList.remove('hidden'); }
      renderTabs(); persistUI();
    } },
    { sep: true },
    { label: 'Copy Path', action: async () => {
      try { await navigator.clipboard.writeText(p); }
      catch { prompt('Copy the path:', p); }
    } },
  ]);
}

/* ---------------- file operations behind the menus ---------------- */
async function newFileAt(dir, type) {
  const name = prompt(type === 'dir' ? `New folder inside ${dir}:` : `New file inside ${dir}:`);
  if (!name) return;
  const rel = dir + '/' + name.replace(/^\/+|\/+$/g, '');
  try {
    await api('/api/file/new', { body: { project: state.project, path: rel, type } });
    await refreshTree();
    if (type === 'file') openFile(rel);
  } catch (e) { alert(e.message); }
}
async function newFolderRoot() {
  const name = prompt('New folder at project root:');
  if (!name) return;
  try {
    await api('/api/file/new', { body: { project: state.project, path: name.replace(/^\/+|\/+$/g, ''), type: 'dir' } });
    await refreshTree();
  } catch (e) { alert(e.message); }
}
async function renamePath(p) {
  const base = p.split('/').pop();
  const name = prompt('Rename to:', base);
  if (!name || name === base) return;
  const np = p.slice(0, p.length - base.length) + name;
  try {
    await api('/api/file/rename', { body: { project: state.project, path: p, newPath: np } });
    // retitle open tabs under the old path (works for files AND folders)
    for (const [k, t] of [...state.tabs.entries()]) {
      if (k === p || k.startsWith(p + '/')) {
        const nk = np + k.slice(p.length);
        state.tabs.delete(k);
        state.tabs.set(nk, { ...t, path: nk });
        if (state.active === k) state.active = nk;
      }
    }
    await refreshTree(); renderTabs(); markTabDirty(); persistUI();
    log(`<span class="info">Renamed ${esc(p)} → ${esc(np)}</span>`);
  } catch (e) { alert(e.message); }
}
async function deletePath(p, isDir) {
  if (!confirm(`Delete ${isDir ? 'folder and EVERYTHING inside it' : 'file'}?\n\n${p}\n\n(this cannot be undone)`)) return;
  try {
    await api('/api/file/delete', { body: { project: state.project, path: p } });
    for (const k of [...state.tabs.keys()]) {
      if (k === p || k.startsWith(p + '/')) { state.tabs.delete(k); if (state.active === k) state.active = null; }
    }
    if (!state.active) { $('editor-wrap').classList.add('hidden'); $('welcome').classList.remove('hidden'); hideBanner(); }
    await refreshTree(); renderTabs(); persistUI();
    log(`<span class="info">Deleted ${esc(p)}</span>`);
  } catch (e) { alert(e.message); }
}
async function downloadFile(p) {
  try {
    const f = await api(`/api/file?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(p)}`);
    const blob = new Blob([f.content], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = p.split('/').pop();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { alert(e.message); }
}

/* ---------------- global shortcuts ---------------- */
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); qoOpen(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
  if (e.key === 'Escape') { if (qo.open) qoClose(); hideCtxMenu(); closeFileOps(); $('commit-modal').classList.add('hidden'); }
});

/* ---------------- sidebar (VS Code style collapse, Ctrl+B) ---------------- */
function toggleSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
  ls.set('cd.sidebar', document.body.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open');
}
$('btn-toggle-sidebar').onclick = toggleSidebar;
$('sidebar-grip').onclick = toggleSidebar;

/* ---------------- UI state persistence ---------------- */
function persistUI() {
  if (!state.project) return;
  ls.set('cd.project', state.project);
  stashActive();
  ls.set(`cd.tabs::${state.project}`, JSON.stringify({ open: [...state.tabs.keys()], active: state.active }));
  ls.set(`cd.expanded::${state.project}`, JSON.stringify([...state.expanded]));
}
window.addEventListener('beforeunload', () => {
  stashActive();
  const t = curTab();
  if (state.active && t && t.dirty && !editor.readOnly) saveDraft(state.active, editor.value, t.mtime);
  persistUI();
});
$('btn-toggle-console').onclick = () => {
  $('console-pane').classList.toggle('collapsed');
  ls.set('cd.console', $('console-pane').classList.contains('collapsed') ? 'collapsed' : 'open');
};
$('btn-clear-console').onclick = () => { $('console').innerHTML = ''; };

/* ---------------- file ops dialog (create/delete with "/" paths) ---------------- */
function openFileOps() {
  if (!state.project) return;
  const base = state.active ? state.active.split('/').slice(0, -1).join('/') + '/' : 'app/src/main/java/';
  $('fileops-input').value = base;
  $('fileops-modal').classList.remove('hidden');
  setTimeout(() => { const i = $('fileops-input'); i.focus(); i.selectionStart = i.selectionEnd = i.value.length; }, 0);
}
function closeFileOps() { $('fileops-modal').classList.add('hidden'); }
async function fileOp(kind) {
  let rel = $('fileops-input').value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) return;
  try {
    if (kind === 'delete') {
      if (!confirm(`Delete?\n\n${rel}\n\nIf it's a folder, EVERYTHING inside goes too. Cannot be undone.`)) return;
      await api('/api/file/delete', { body: { project: state.project, path: rel } });
      for (const k of [...state.tabs.keys()]) {
        if (k === rel || k.startsWith(rel + '/')) { state.tabs.delete(k); if (state.active === k) state.active = null; }
      }
      if (!state.active) { $('editor-wrap').classList.add('hidden'); $('welcome').classList.remove('hidden'); hideBanner(); }
      log(`<span class="info">🗑 Deleted <b>${esc(rel)}</b></span>`);
    } else {
      await api('/api/file/new', { body: { project: state.project, path: rel, type: kind === 'dir' ? 'dir' : 'file' } });
      log(`<span class="info">＋ Created ${kind === 'dir' ? 'folder' : 'file'} <b>${esc(rel)}</b></span>`);
      if (kind !== 'dir') openFile(rel);
    }
    closeFileOps();
    await refreshTree();
  } catch (e) { alert(e.message); }
}
$('btn-file-ops').onclick = openFileOps;
$('btn-close-fileops').onclick = closeFileOps;
$('fileops-modal').onclick = (e) => { if (e.target.id === 'fileops-modal') closeFileOps(); };
$('btn-fo-create-file').onclick = () => fileOp('file');
$('btn-fo-create-dir').onclick = () => fileOp('dir');
$('btn-fo-delete').onclick = () => fileOp('delete');
$('fileops-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') fileOp('file'); if (e.key === 'Escape') closeFileOps(); });

/* ---------------- commit dialog (GitHub-style) ---------------- */
let gitChangesCount = 0;
async function openCommit() {
  if (!state.project) return;
  $('commit-modal').classList.remove('hidden');
  $('commit-msg').value = ''; $('commit-desc').value = '';
  $('commit-branch').textContent = 'checking git status…';
  $('commit-files').innerHTML = '<div class="dim">…</div>';
  try {
    const s = await api('/api/git/status?project=' + encodeURIComponent(state.project));
    $('commit-branch').textContent = s.inRepo
      ? `branch: ${s.branch} · ${s.changes.length} change(s) in projects/${state.project}/`
      : 'not a git repo yet — committing will run `git init` and make the first commit';
    renderCommitFiles(s);
  } catch (e) {
    $('commit-branch').textContent = 'git unavailable';
    $('commit-files').innerHTML = '<div class="dim">' + esc(e.message) + '</div>';
    gitChangesCount = 0;
  }
  validateCommit();
  setTimeout(() => $('commit-msg').focus(), 0);
}
function renderCommitFiles(s) {
  const host = $('commit-files');
  host.innerHTML = '';
  if (!s.inRepo) {
    gitChangesCount = 1;
    host.innerHTML = '<div class="dim">Everything in the project becomes the first commit.</div>';
    return;
  }
  gitChangesCount = s.changes.length;
  if (!s.changes.length) {
    host.innerHTML = '<div class="dim">Working tree clean — nothing to commit for this project.</div>';
    return;
  }
  for (const c of s.changes.slice(0, 200)) {
    const d = document.createElement('div');
    d.className = 'commit-file';
    const rel = c.path.replace(`projects/${state.project}/`, '');
    d.innerHTML = `<span class="st st-${esc(c.status[0] || '?')}">${esc(c.status)}</span>${esc(rel)}`;
    host.appendChild(d);
  }
  if (s.changes.length > 200) {
    const d = document.createElement('div');
    d.className = 'commit-file';
    d.textContent = `… and ${s.changes.length - 200} more`;
    host.appendChild(d);
  }
}
function validateCommit() {
  $('btn-do-commit').disabled = !(gitChangesCount > 0 && $('commit-msg').value.trim().length > 0);
}
$('btn-commit').onclick = openCommit;
$('btn-close-commit').onclick = () => $('commit-modal').classList.add('hidden');
$('commit-modal').onclick = (e) => { if (e.target.id === 'commit-modal') $('commit-modal').classList.add('hidden'); };
$('commit-msg').addEventListener('input', validateCommit);
$('commit-msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('btn-do-commit').disabled) $('btn-do-commit').click(); });
$('btn-do-commit').onclick = async () => {
  const message = $('commit-msg').value.trim();
  if (!message) return;
  $('btn-do-commit').disabled = true;
  $('btn-do-commit').textContent = '⏳ Committing…';
  try {
    await saveAll(); // commit what's on screen, drafts included
    const r = await api('/api/git/commit', {
      body: { project: state.project, message, description: $('commit-desc').value.trim() },
    });
    $('commit-modal').classList.add('hidden');
    log(`<span class="apk-line">⎇ Commit <b>${esc(r.hash)}</b> on <b>${esc(r.branch)}</b> — “${esc(message)}”</span>`);
    if (r.repoCreated) log('<span class="info">(also ran git init — this is the first commit)</span>');
  } catch (e) {
    log('<span class="err">Commit failed: ' + esc(e.message) + '</span>');
    alert('Commit failed: ' + e.message);
  } finally {
    $('btn-do-commit').textContent = '⎇ Commit';
    validateCommit();
  }
};

/* ---------------- wire up ---------------- */
$('btn-build').onclick = build;
$('btn-save').onclick = saveActive;
$('btn-new-file').onclick = newFile;
$('btn-new-project').onclick = newProject;
$('btn-help').onclick = () => $('help-modal').classList.remove('hidden');
$('btn-close-help').onclick = () => $('help-modal').classList.add('hidden');
$('help-modal').onclick = (e) => { if (e.target.id === 'help-modal') $('help-modal').classList.add('hidden'); };
$('project-select').onchange = async (e) => {
  stashActive();
  persistUI();
  state.tabs.clear(); state.active = null; hideBanner();
  $('editor-wrap').classList.add('hidden'); $('welcome').classList.remove('hidden');
  $('btn-apk').classList.add('hidden');
  await loadProjects(e.target.value);
};

/* ---------------- boot ---------------- */
(async function boot() {
  try {
    log('<span class="info">Welcome to code-droid! The light Android IDE. 🤖<br>Ctrl+P quick-open · Ctrl+Shift+F search · Ctrl+B explorer · drafts auto-saved in your browser · Import/Export .zip · ⟳ restart.</span>');
    // server discovery: same-origin first, then a saved local server —
    // that's how the GitHub Pages page can drive a code-droid server
    // running on the user's own machine (builds run locally there).
    try {
      const hr = await fetch('/api/health', { cache: 'no-store' });
      if (!hr.ok) throw new Error('no same-origin server');
    } catch {
      const saved = (ls.get('cd.server') || '').replace(/\/+$/, '');
      let connected = false;
      if (saved) {
        try {
          const r2 = await fetch(saved + '/api/health', { cache: 'no-store' });
          if (r2.ok) { API_BASE = saved; connected = true; }
        } catch { /* saved server not running */ }
      }
      CD_STATIC = !connected;
    }
    if (CD_STATIC) log('<span class="info">📄 <b>Static demo mode</b> — no code-droid server detected. Explorer & editing work; changes stay in this browser.\nFor local APK builds: run <b>node server/server.js</b> on your machine, then press 🔌 Connect here.</span>');
    else if (API_BASE) log('<span class="info">🔌 Connected to local server <b>' + esc(API_BASE) + '</b> — files & builds live on that machine.</span>');
    if (ls.get('cd.console') === 'collapsed') $('console-pane').classList.add('collapsed');
    if (ls.get('cd.sidebar') === 'collapsed') document.body.classList.add('sidebar-collapsed');
    const savedProject = ls.get('cd.project');
    await Promise.all([checkTools(), loadProjects(savedProject || undefined)]);
    // restore tabs & active file
    try {
      const tabsState = JSON.parse(ls.get(`cd.tabs::${state.project}`) || 'null');
      if (tabsState && tabsState.open && tabsState.open.length) {
        for (const p of tabsState.open) { await openFile(p, { silent: true }); }
        if (tabsState.active && state.tabs.has(tabsState.active)) await openFile(tabsState.active);
      }
    } catch { /* fresh start */ }
  } catch (e) {
    // never fail silently: put startup errors where the user can see them
    hideBanner();
    try { $('console-pane').classList.remove('collapsed'); } catch { /* ignore */ }
    log('<span class="err">⚠ Startup error: ' + esc(e.message) + '\nTry ⟳ Restart, or clear site data (localStorage) if it keeps happening.</span>');
  }
})();
