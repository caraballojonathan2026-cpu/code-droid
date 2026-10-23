#!/usr/bin/env node
// Regenerates web/static-files.json from templates/hello/ for static demo mode
// (GitHub Pages, file://, sandboxed previews — anywhere without the node server).
// Run: node tools/make-static-manifest.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TPL = path.join(ROOT, 'templates', 'hello');
const OUT = path.join(ROOT, 'web', 'static-files.json');

function walk(dir, base = '') {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? base + '/' + e.name : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, walk(full, rel));
    else out[rel] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

let appName = 'hello-droid';
try { appName = JSON.parse(fs.readFileSync(path.join(TPL, 'code-droid.json'), 'utf8')).appName || appName; } catch {}
const manifest = { project: { id: 'hello-droid', name: appName }, files: walk(TPL) };
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1) + '\n');
console.log(`wrote ${OUT} (${Object.keys(manifest.files).length} files)`);
