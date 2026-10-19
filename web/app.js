/* code-droid web IDE — zero dependencies, talks to the code-droid server API. */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  project: null,
  tabs: new Map(),   // path -> { content, saved, dirty }
  active: null,
  built: false,
};

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, opts.body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body),
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
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/* ---------------- tools status ---------------- */
async function checkTools() {
  const badge = $('tool-status');
  try {
    const t = await api('/api/tools');
    if (t.ready) {
      badge.textContent = '● toolchain ready';
      badge.className = 'badge ready';
      badge.title = 'aapt2, kotlinc, d8, zipalign, apksigner found';
    } else {
      badge.textContent = '⚠ toolchain incomplete';
      badge.className = 'badge missing';
      badge.title = 'Missing: ' + t.missing.join(', ') + '\nFix: run  bash tools/install.sh  then restart the server.\n(click for details)';
      badge.onclick = () => {
        log('<span class="err">Toolchain incomplete — missing: <b>' + esc(t.missing.join(', ')) + '</b></span>');
        log('<span class="info">Run this in a terminal inside the code-droid folder, then restart the server:\n\n  bash tools/install.sh\n\nIt downloads ~300MB (Kotlin compiler + Android build-tools + one android.jar platform). One-time setup.</span>');
      };
    }
  } catch (e) {
    badge.textContent = '? tools unknown';
    badge.className = 'badge unknown';
  }
}

/* ---------------- projects & file tree ---------------- */
async function loadProjects(selectId) {
  const { projects } = await api('/api/projects');
  const sel = $('project-select');
  sel.innerHTML = '';
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = '📦 ' + p.name;
    sel.appendChild(o);
  }
  state.project = selectId || (projects[0] && projects[0].id);
  if (state.project) sel.value = state.project;
  await refreshTree();
}

async function refreshTree() {
  if (!state.project) return;
  const { tree } = await api('/api/files?project=' + encodeURIComponent(state.project));
  const host = $('file-tree');
  host.innerHTML = '';
  host.appendChild(renderTree(tree));
}

const ICONS = { kt: '<span style="color:#7f52ff">K</span>', xml: '<span style="color:#e8bf6a">◈</span>', json: '{ }', gradle: 'G', md: 'Ⓜ', default: '·' };
function iconFor(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ICONS[ext] || ICONS.default;
}

function renderTree(nodes) {
  const ul = document.createElement('ul');
  for (const n of nodes) {
    const li = document.createElement('li');
    if (n.type === 'dir') li.className = 'tree-dir';
    const item = document.createElement('div');
    item.className = 'tree-item' + (state.active === n.path ? ' active' : '');
    item.innerHTML = `<span class="ico">${n.type === 'dir' ? '▸' : iconFor(n.name)}</span>${esc(n.name)}`;
    item.dataset.path = n.path;
    if (n.type === 'file') {
      item.onclick = () => openFile(n.path);
    } else {
      const child = renderTree(n.children || []);
      item.onclick = () => { child.style.display = child.style.display === 'none' ? '' : 'none'; item.querySelector('.ico').textContent = child.style.display === 'none' ? '▸' : '▾'; };
      item.querySelector('.ico').textContent = '▾';
      li.appendChild(item); li.appendChild(child); ul.appendChild(li);
      continue;
    }
    li.appendChild(item); ul.appendChild(li);
  }
  return ul;
}

/* ---------------- editor ---------------- */
const editor = $('editor');
const hlLayer = $('highlight-layer');
const hlCode = $('highlight-code');

function renderEditor() {
  const t = state.tabs.get(state.active);
  if (!t) return;
  hlCode.innerHTML = CDHighlight(state.active, editor.value);
}
function syncScroll() {
  hlLayer.scrollTop = editor.scrollTop;
  hlLayer.scrollLeft = editor.scrollLeft;
}
function updateCursor() {
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  const ln = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  $('cursor-pos').textContent = `Ln ${ln}, Col ${col}`;
}

editor.addEventListener('input', () => {
  const t = state.tabs.get(state.active);
  if (!t) return;
  t.dirty = editor.value !== t.saved;
  renderEditor();
  markTabDirty();
});
editor.addEventListener('scroll', syncScroll);
editor.addEventListener('keyup', updateCursor);
editor.addEventListener('click', updateCursor);
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); insertAtCursor('    '); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
});
function insertAtCursor(text) {
  const s = editor.selectionStart, epos = editor.selectionEnd;
  editor.value = editor.value.slice(0, s) + text + editor.value.slice(epos);
  editor.selectionStart = editor.selectionEnd = s + text.length;
  editor.dispatchEvent(new Event('input'));
}

async function openFile(p) {
  if (!state.tabs.has(p)) {
    const { content } = await api(`/api/file?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(p)}`);
    state.tabs.set(p, { content, saved: content, dirty: false });
  }
  state.active = p;
  $('welcome').classList.add('hidden');
  $('editor-wrap').classList.remove('hidden');
  editor.value = state.tabs.get(p).content;
  renderEditor(); renderTabs(); syncScroll(); updateCursor();
  $('file-status').textContent = p;
  $('file-status').className = '';
  document.querySelectorAll('.tree-item.active').forEach((x) => x.classList.remove('active'));
  const el = document.querySelector(`.tree-item[data-path="${CSS.escape(p)}"]`);
  if (el) el.classList.add('active');
}

function renderTabs() {
  const host = $('tabs');
  host.innerHTML = '';
  for (const [p, t] of state.tabs) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (p === state.active ? ' active' : '');
    tab.dataset.path = p;
    tab.innerHTML = `${esc(p.split('/').pop())}${t.dirty ? '<span class="dot">●</span>' : ''}<span class="x">✕</span>`;
    tab.querySelector('.x').onclick = (ev) => { ev.stopPropagation(); closeTab(p); };
    tab.onclick = () => openFile(p);
    host.appendChild(tab);
  }
}
function markTabDirty() {
  const t = state.tabs.get(state.active);
  $('file-status').textContent = state.active + (t.dirty ? ' — unsaved changes' : '');
  $('file-status').className = t.dirty ? 'dirty' : '';
  renderTabs();
}
function closeTab(p) {
  const t = state.tabs.get(p);
  if (t && t.dirty && !confirm(`Discard unsaved changes in ${p}?`)) return;
  state.tabs.delete(p);
  if (state.active === p) {
    state.active = [...state.tabs.keys()].pop() || null;
    if (state.active) openFile(state.active);
    else { $('editor-wrap').classList.add('hidden'); $('welcome').classList.remove('hidden'); }
  }
  renderTabs();
}

async function saveActive() {
  if (!state.active) return;
  const t = state.tabs.get(state.active);
  t.content = editor.value;
  await api('/api/file', { body: { project: state.project, path: state.active, content: editor.value } });
  t.saved = editor.value; t.dirty = false;
  markTabDirty(); renderTabs();
}

async function saveAll() {
  for (const [p, t] of state.tabs) {
    if (!t.dirty) continue;
    if (p === state.active) t.content = editor.value;
    await api('/api/file', { body: { project: state.project, path: p, content: t.content } });
    t.saved = t.content; t.dirty = false;
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
      if (r.missing) log(`<span class="info">Missing tools: ${esc(r.missing.join(', '))}\nFix: run  bash tools/install.sh  and restart the server.</span>`);
    }
  } catch (e) {
    $('build-summary').textContent = '✖ error';
    log(`<span class="err">✖ ${esc(e.message)}</span>`);
  } finally {
    btn.disabled = false; btn.innerHTML = '▶ Build APK';
  }
}

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
    state.tabs.clear(); state.active = null;
    $('editor-wrap').classList.add('hidden'); $('welcome').classList.remove('hidden');
    await loadProjects(project.id);
    log(`<span class="info">Created project <b>${esc(project.id)}</b> from template.</span>`);
  } catch (e) { alert(e.message); }
}

/* ---------------- wire up ---------------- */
$('btn-build').onclick = build;
$('btn-save').onclick = saveActive;
$('btn-new-file').onclick = newFile;
$('btn-new-project').onclick = newProject;
$('btn-help').onclick = () => $('help-modal').classList.remove('hidden');
$('btn-close-help').onclick = () => $('help-modal').classList.add('hidden');
$('help-modal').onclick = (e) => { if (e.target.id === 'help-modal') $('help-modal').classList.add('hidden'); };
$('project-select').onchange = (e) => {
  state.tabs.clear(); state.active = null;
  $('editor-wrap').classList.add('hidden'); $('welcome').classList.remove('hidden');
  $('btn-apk').classList.add('hidden');
  state.project = e.target.value;
  renderTabs(); refreshTree();
};
$('btn-toggle-console').onclick = () => $('console-pane').classList.toggle('collapsed');
$('btn-clear-console').onclick = () => { $('console').innerHTML = ''; };

(async function boot() {
  log('<span class="info">Welcome to code-droid! The light Android IDE. 🤖</span>');
  await Promise.all([checkTools(), loadProjects()]);
})();
