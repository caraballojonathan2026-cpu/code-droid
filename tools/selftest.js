#!/usr/bin/env node
/*
 * code-droid self-test — proves the APK compiler works end to end.
 * Runs the real build pipeline against the bundled hello-droid project
 * and verifies: toolchain discovery, every pipeline step, APK existence,
 * signature verification, and the dex cache on the second build.
 *
 *   node tools/selftest.js     (or: npm test)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { discoverTools } = require('../server/toolchain');
const { buildProject } = require('../server/builder');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'projects', 'hello-droid');

let failures = 0;
const ok = (cond, label) => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label);
  if (!cond) failures++;
};

console.log('code-droid self-test\n====================\n');

(async () => {
// 1) toolchain
console.log('[1/5] Toolchain discovery');
const tools = discoverTools();
ok(tools.ready, 'toolchain ready' + (tools.ready ? '' : ' — missing: ' + tools.missing.join(', ')));
if (!tools.ready) {
  console.log('\nFix: bash tools/install.sh');
  process.exit(1);
}

// ensure the sample project exists (store.init does this when the server runs)
if (!fs.existsSync(PROJECT)) {
  const store = require('../server/store');
  store.init({ projectsDir: path.join(ROOT, 'projects'), templatesDir: path.join(ROOT, 'templates') });
}
ok(fs.existsSync(path.join(PROJECT, 'app/src/main/AndroidManifest.xml')), 'hello-droid sample project present');

// 2) first build — force a full run even if a previous session left things up to date
console.log('\n[2/5] Build #1 — full pipeline');
const mainKt = path.join(PROJECT, 'app/src/main/java/com/example/hellodroid/MainActivity.kt');
const bump = new Date();
fs.utimesSync(mainKt, bump, bump); // mtime change => signature changes => full pipeline guaranteed
let r = await buildProject(PROJECT, discoverTools());
for (const s of r.steps) console.log(`     ${s.ok ? '✔' : '✖'} ${s.name} (${s.ms}ms)`);
ok(r.ok, 'BUILD #1 SUCCESSFUL in ' + (r.totalMs / 1000).toFixed(1) + 's');
const apk = path.join(PROJECT, 'build', 'app-debug.apk');
ok(fs.existsSync(apk), 'APK exists: ' + apk);
if (fs.existsSync(apk)) {
  const kb = Math.round(fs.statSync(apk).size / 1024);
  ok(kb > 100 && kb < 50000, `APK size sane (${kb} KB)`);
}
const verifyStep = r.steps.find((s) => s.name === 'verify');
ok(verifyStep && verifyStep.ok, 'apksigner verify passed (APK is properly signed)');

// 3) unchanged build must be served instantly from the input-signature cache
console.log('\n[3/5] Build #2 — unchanged inputs');
r = await buildProject(PROJECT, discoverTools());
ok(r.ok && r.upToDate === true, 'BUILD #2 skipped (APK up to date) in ' + r.totalMs + 'ms');

// 4) after touching a source, rebuild hits the dex cache
console.log('\n[4/5] Build #3 — one file changed');
const now2 = new Date();
fs.utimesSync(mainKt, now2, now2); // mtime bump => signature changes => real rebuild
r = await buildProject(PROJECT, discoverTools());
ok(r.ok && !r.upToDate, 'BUILD #3 SUCCESSFUL in ' + (r.totalMs / 1000).toFixed(1) + 's');
const cached = r.steps.find((s) => s.name.startsWith('d8 (kotlin-stdlib)') && /cached/.test(s.log || ''));
ok(!!cached, 'kotlin-stdlib dex served from cache (0ms)');

// 5) APK contents sanity
console.log('\n[5/5] APK structure');
const buf = fs.readFileSync(apk);
ok(buf.slice(0, 2).toString() === 'PK', 'APK is a valid zip/JAR container');
ok(buf.includes('AndroidManifest.xml'), 'contains AndroidManifest.xml');
ok(buf.includes('classes.dex'), 'contains classes.dex');
ok(buf.includes('classes2.dex') || !fs.existsSync(path.join(PROJECT, 'build', 'dex-final', 'classes2.dex')), 'multidex shards consistent');

console.log('\n====================');
if (failures) {
  console.log(`✖ SELF-TEST FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log('✔ ALL CHECKS PASSED — the compiler works. 🎉');
})().catch((e) => { console.error('✖ SELF-TEST CRASHED:', e); process.exit(1); });
