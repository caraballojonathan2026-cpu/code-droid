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
async function api(path, opts = {}) {
  const res = await fetch(path, opts.body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body),
  } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.steps) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
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
      $('btn-apk').classList.remove('hidden');
      $('btn-apk').href = '/api/apk?project=' + encodeURIComponent(state.project);
      $('btn-apk').textContent = `⬇ APK (${r.sizeKB} KB)`;
      $('build-summary').textContent = `✔ OK in ${(r.totalMs / 1000).toFixed(1)}s — ${r.sizeKB} KB`;
      log(`<span class="apk-line">✔ BUILD SUCCESSFUL in ${(r.totalMs / 1000).toFixed(1)}s — ${esc(r.apk)} (${r.sizeKB} KB)</span>`);
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
  if (!state.project) return;
  saveAll().finally(() => {
    location.href = '/api/project/export?project=' + encodeURIComponent(state.project);
  });
};
$('btn-import').onclick = () => $('import-file').click();
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  log(`<span class="info">⇧ Importing ${esc(f.name)} (${fmtSize(f.size)})…</span>`);
  try {
    const res = await fetch('/api/project/import?name=' + encodeURIComponent(f.name.replace(/\.zip$/i, '')), {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: f,
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'import failed');
    log(`<span class="apk-line">✔ Imported as project <b>${esc(d.imported)}</b></span>`);
    await loadProjects(d.imported);
  } catch (err) { log('<span class="err">Import failed: ' + esc(err.message) + '</span>'); }
});

$('btn-restart').onclick = async () => {
  if (!confirm('Restart the code-droid server?\n\nYour open tabs and unsaved work are backed up in this browser and will come back.')) return;
  stashActive();
  if (state.active && curTab().dirty) saveDraft(state.active, editor.value, curTab().mtime);
  persistUI();
  try { await fetch('/api/restart', { method: 'POST' }); } catch { /* server already gone */ }
  log('<span class="info">⟳ Restarting server…</span>');
  let back = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const r = await fetch('/api/health'); if (r.ok) { back = true; break; } } catch { /* down */ }
  }
  if (back) {
    log('<span class="step-ok">✔ Server is back — reloading the IDE (your work is restored from localStorage).</span>');
    setTimeout(() => location.reload(), 700);
  } else {
    log('<span class="err">Server did not come back. If it was started directly (node server/server.js),\nstart it again with: npm start  (uses launcher.js, which makes ⟳ work).</span>');
  }
};

/* ---------------- global shortcuts ---------------- */
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); qoOpen(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
  if (e.key === 'Escape') { if (qo.open) qoClose(); }
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
