// Headless build for CI (GitHub Actions): builds projects/hello-droid with the
// project's own direct pipeline and exits non-zero on failure.
// Run: node tools/ci-build.js   (after: bash tools/install.sh)
'use strict';
const path = require('path');
const { buildProject } = require('../server/builder');
const { discoverTools } = require('../server/toolchain');

(async () => {
  const toolsInfo = discoverTools();
  if (!toolsInfo.ready) {
    console.error('Toolchain incomplete — missing:', toolsInfo.missing.join(', '));
    process.exit(1);
  }
  const projectRoot = path.join(__dirname, '..', 'projects', 'hello-droid');
  const r = await buildProject(projectRoot, toolsInfo);
  for (const s of r.steps || []) console.log(`${s.ok ? '✔' : '✖'} ${s.name} (${s.ms}ms)`);
  if (!r.ok) {
    console.error('BUILD FAILED:', r.error);
    process.exit(1);
  }
  console.log(`BUILD SUCCESSFUL — ${r.apk} (${r.sizeKB} KB) in ${(r.totalMs / 1000).toFixed(1)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
