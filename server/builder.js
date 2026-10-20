/*
 * builder.js — the code-droid direct build pipeline. NO Gradle. Async, non-blocking.
 *
 *   1. aapt2 compile  res/            -> res.zip
 *   2. aapt2 link     manifest + res  -> unsigned.apk + generated R.java
 *   3. kotlinc ‖ javac (parallel)     Kotlin -> classes, R.java -> R classes
 *   4. d8             classes         -> classes.dex      (project code only!)
 *      d8 (cached)    kotlin-stdlib   -> classesN.dex     (dexed ONCE, then reused)
 *   5. zip            all *.dex       -> injected into unsigned.apk (native multidex)
 *   6. zipalign       4-byte align    -> aligned.apk
 *   7. apksigner      debug keystore  -> app-debug.apk
 *
 * Performance design:
 *  - All tool invocations use async spawn(): the HTTP server never freezes
 *    while a build runs, so the IDE stays responsive on big projects.
 *  - Input signature (path+mtime+size of every source + toolchain versions):
 *    if nothing changed since the last build, the KNOWN-GOOD APK is served
 *    instantly ("up to date") instead of recompiling the world.
 *  - kotlin-stdlib dex is cached per (jar, minSdk) under tools/dex-cache.
 *  - kotlinc and javac(R.java) run IN PARALLEL — they are independent.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_LOG = 1024 * 1024; // keep at most the last 1MB of a tool's output

/* repo root relative to projects/<name>/ */
const repoRootOf = (projectRoot) => path.resolve(path.dirname(projectRoot), '..');
const releaseFileFor = (projectRoot) =>
  path.join(repoRootOf(projectRoot), 'releases', `${path.basename(projectRoot)}-debug.apk`);

function run(name, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let proc;
    try {
      proc = spawn(cmd, args, {
        env: { ...process.env, JAVA_OPTS: process.env.JAVA_OPTS || '-Xmx1536m' },
        ...opts,
      });
    } catch (e) {
      return resolve({ name, ok: false, ms: Date.now() - t0, log: e.message });
    }
    let out = '';
    const cap = (d) => { out += d; if (out.length > MAX_LOG) out = out.slice(-MAX_LOG); };
    proc.stdout.on('data', cap);
    proc.stderr.on('data', cap);
    proc.on('error', (e) => resolve({ name, ok: false, ms: Date.now() - t0, log: e.message }));
    proc.on('close', (code) => resolve({ name, ok: code === 0, ms: Date.now() - t0, log: out.trim() }));
  });
}

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (!ext || e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function walkAll(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'build' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

function dexShards(dir) {
  try { return fs.readdirSync(dir).filter((f) => /^classes(\d*)\.dex$/.test(f)).sort(); }
  catch { return []; }
}

/* Cheap change detector: path + size + mtime of every file under src/,
 * plus toolchain bits that affect the output. Make-style, content-free. */
function inputsSignature(projectRoot, srcMain, T, minApi, targetApi) {
  const h = crypto.createHash('sha1');
  h.update(`v3|${minApi}|${targetApi}|${T.sdk.androidJar}|${path.basename(T.kotlin.home)}`);
  const files = walkAll(srcMain).sort();
  for (const f of files) {
    const st = fs.statSync(f);
    h.update(`${path.relative(projectRoot, f)}|${st.size}|${Math.round(st.mtimeMs)};`);
  }
  return { sig: h.digest('hex'), fileCount: files.length };
}

async function ensureKeystore(tools, steps) {
  if (fs.existsSync(tools.keystore)) return true;
  fs.mkdirSync(path.dirname(tools.keystore), { recursive: true });
  if (tools.java && tools.java.keytool) {
    const s = await run('keystore', tools.java.keytool, [
      '-genkeypair', '-v', '-keystore', tools.keystore,
      '-storepass', 'android', '-keypass', 'android',
      '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '10000', '-dname', 'CN=Android Debug,O=code-droid,C=US',
    ]);
    steps.push(s);
    return s.ok;
  }
  steps.push({ name: 'keystore', ok: false, ms: 0, log: 'keytool not found (it ships with every JDK).' });
  return false;
}

async function ensureStdlibDex(T, minApi, toolsRoot, steps) {
  if (!T.kotlin.stdlib || !fs.existsSync(T.kotlin.stdlib)) return null;
  const st = fs.statSync(T.kotlin.stdlib);
  const cacheDir = path.join(toolsRoot, 'dex-cache', `stdlib-${st.size}-${minApi}`);
  if (dexShards(cacheDir).length) {
    steps.push({ name: 'd8 (kotlin-stdlib)', ok: true, ms: 0, log: 'cached ✔ (delete tools/dex-cache to rebuild)' });
    return cacheDir;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const s = await run('d8 (kotlin-stdlib, one-time)', T.d8, ['--release', '--lib', T.sdk.androidJar,
    '--min-api', minApi, '--output', cacheDir, T.kotlin.stdlib]);
  steps.push(s);
  return s.ok ? cacheDir : null;
}

async function buildProject(projectRoot, toolsInfo) {
  if (!toolsInfo.ready) {
    return {
      ok: false, stage: 'toolchain', missing: toolsInfo.missing,
      error: 'Toolchain incomplete. Run: ' + toolsInfo.installHint, steps: [],
    };
  }
  const T = toolsInfo.tools;
  const srcMain = path.join(projectRoot, 'app', 'src', 'main');
  const manifest = path.join(srcMain, 'AndroidManifest.xml');
  const resDir = path.join(srcMain, 'res');
  const javaDir = path.join(srcMain, 'java');
  const buildDir = path.join(projectRoot, 'build');
  const genDir = path.join(buildDir, 'gen');
  const classesDir = path.join(buildDir, 'classes');
  const projectDexDir = path.join(buildDir, 'dex');
  const finalDexDir = path.join(buildDir, 'dex-final');
  const unsignedApk = path.join(buildDir, 'unsigned.apk');
  const alignedApk = path.join(buildDir, 'aligned.apk');
  const finalApk = path.join(buildDir, 'app-debug.apk');
  const sigFile = path.join(projectRoot, '.cd-build.json');

  if (!fs.existsSync(manifest)) return { ok: false, error: 'No app/src/main/AndroidManifest.xml — is this a code-droid project?', steps: [] };

  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'code-droid.json'), 'utf8')); } catch { return {}; } })();
  const minApiNum = Math.max(Number(meta.minSdk) || 21, 21); // 21+ => native multidex
  const minApi = String(minApiNum);
  const platformApi = (() => { const m = /android-(\d+)/.exec(T.sdk.platform || ''); return m ? Number(m[1]) : 33; })();
  const targetApi = String(Math.min(Number(meta.targetSdk || platformApi), platformApi));

  const t0 = Date.now();
  const steps = [];
  const step = async (name, cmd, args, opts) => { const s = await run(name, cmd, args, opts); steps.push(s); return s.ok; };
  const fail = (s) => ({ ok: false, steps: s, error: (s.filter((x) => !x.ok).pop() || {}).name + ' failed' });
  const install = () => ({
    adb: `adb install -r "${finalApk}"`,
    manual: 'Or copy the APK to your phone (USB, Drive, messaging) and tap it. Allow "install from unknown sources" when asked.',
  });

  // ---- up-to-date check: skip EVERYTHING when inputs are unchanged ----
  const { sig, fileCount } = inputsSignature(projectRoot, srcMain, T, minApi, targetApi);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(sigFile, 'utf8')); } catch { /* no prior build */ }
  if (prev && prev.sig === sig && fs.existsSync(finalApk)) {
    const ms = Date.now() - t0;
    return {
      ok: true, upToDate: true, apk: 'build/app-debug.apk',
      release: fs.existsSync(releaseFileFor(projectRoot))
        ? `releases/${path.basename(releaseFileFor(projectRoot))}` : null,
      sizeKB: Math.round(fs.statSync(finalApk).size / 1024), totalMs: ms,
      steps: [{ name: `inputs check (${fileCount} files)`, ok: true, ms, log: 'No changes since the last build — APK is up to date ✔' }],
      install: install(),
    };
  }

  fs.rmSync(buildDir, { recursive: true, force: true });
  for (const d of [buildDir, genDir, classesDir, projectDexDir, finalDexDir]) fs.mkdirSync(d, { recursive: true });

  // 1) compile resources (optional for code-only UIs)
  if (fs.existsSync(resDir) && fs.readdirSync(resDir).length) {
    if (!await step('aapt2 compile', T.aapt2, ['compile', '--dir', resDir, '-o', path.join(buildDir, 'res.zip')])) return fail(steps);
  }

  // 2) link: manifest + resources -> unsigned APK + R.java
  const linkArgs = ['link', '-o', unsignedApk, '-I', T.sdk.androidJar,
    '--manifest', manifest, '--java', genDir,
    '--min-sdk-version', minApi, '--target-sdk-version', targetApi];
  if (fs.existsSync(path.join(buildDir, 'res.zip'))) linkArgs.push(path.join(buildDir, 'res.zip'));
  if (!await step('aapt2 link', T.aapt2, linkArgs)) return fail(steps);

  // 3) kotlinc and javac(R.java) IN PARALLEL — independent once gen/ exists
  const ktRoots = [javaDir, path.join(srcMain, 'kotlin')].filter((d) => fs.existsSync(d) && walk(d, '.kt').length);
  if (!ktRoots.length) return fail(steps.concat([{ name: 'kotlinc', ok: false, ms: 0, log: 'No Kotlin sources under app/src/main/java' }]));
  const ktCount = ktRoots.reduce((n, d) => n + walk(d, '.kt').length, 0);
  const cp = [T.sdk.androidJar, T.kotlin.stdlib].filter(Boolean).join(path.delimiter);
  const genJava = walk(genDir, '.java');

  const parallelJobs = [
    run(`kotlinc (${ktCount} files)`, T.kotlin.bin, [...ktRoots, genDir, '-classpath', cp, '-d', classesDir]),
  ];
  if (genJava.length && toolsInfo.tools.java.javac) {
    parallelJobs.push(run('javac (R.java)  ∥', toolsInfo.tools.java.javac, ['-cp', T.sdk.androidJar, '-d', classesDir, ...genJava]));
  }
  const parallelResults = await Promise.all(parallelJobs);
  steps.push(...parallelResults);
  if (parallelResults.some((s) => !s.ok)) return fail(steps);

  // 4) DEX the project classes (jar first so argument lists stay short on huge projects)
  const classFiles = walk(classesDir, '.class');
  if (!classFiles.length) return fail(steps.concat([{ name: 'd8', ok: false, ms: 0, log: 'kotlinc produced no class files' }]));
  let d8Inputs;
  if (toolsInfo.tools.java.jar) {
    const jarPath = path.join(buildDir, 'classes.jar');
    if (!await step('jar', toolsInfo.tools.java.jar, ['cf', jarPath, '-C', classesDir, '.'])) return fail(steps);
    d8Inputs = [jarPath];
  } else {
    d8Inputs = classFiles;
  }
  if (!await step('d8 (project)', T.d8, ['--release', '--lib', T.sdk.androidJar, '--min-api', minApi, '--output', projectDexDir, ...d8Inputs])) return fail(steps);

  // 4b) cached stdlib dex
  const toolsRoot = path.dirname(toolsInfo.tools.keystore);
  const stdlibCache = await ensureStdlibDex(T, minApi, toolsRoot, steps);
  if (stdlibCache === null && T.kotlin.stdlib) return fail(steps);

  // 5) assemble dex set: project shards first, stdlib shards renumbered after
  const projectShards = dexShards(projectDexDir);
  projectShards.forEach((f, i) => {
    fs.copyFileSync(path.join(projectDexDir, f), path.join(finalDexDir, i === 0 ? 'classes.dex' : `classes${i + 1}.dex`));
  });
  let dexCount = projectShards.length;
  if (stdlibCache) {
    for (const f of dexShards(stdlibCache)) {
      dexCount++;
      fs.copyFileSync(path.join(stdlibCache, f), path.join(finalDexDir, dexCount === 1 ? 'classes.dex' : `classes${dexCount}.dex`));
    }
  }
  const dexPaths = fs.readdirSync(finalDexDir).filter((f) => f.endsWith('.dex')).sort().map((f) => path.join(finalDexDir, f));
  if (!await step(`package ${dexPaths.length} dex`, T.zip, ['-j', unsignedApk, ...dexPaths])) return fail(steps);

  // 6) align
  if (!await step('zipalign', T.zipalign, ['-f', '-p', '4', unsignedApk, alignedApk])) return fail(steps);

  // 7) sign with the debug key
  if (!await ensureKeystore(toolsInfo.tools, steps)) return fail(steps);
  if (!await step('apksigner', T.apksigner, ['sign', '--ks', toolsInfo.tools.keystore,
    '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', finalApk, alignedApk])) return fail(steps);
  await step('verify', T.apksigner, ['verify', finalApk]);

  // remember the signature for next time
  try { fs.writeFileSync(sigFile, JSON.stringify({ sig, at: new Date().toISOString(), fileCount })); } catch { /* non-fatal */ }

  // ALSO surface the APK outside build/ — some environments (cloud workspaces,
  // sandboxed previews) can't see/offer files under build/. releases/ is a
  // normal visible folder, so the artifact is always grabbable.
  let release = null;
  try {
    const dest = releaseFileFor(projectRoot);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(finalApk, dest);
    release = 'releases/' + path.basename(dest);
  } catch { /* best-effort */ }

  return {
    ok: true,
    apk: 'build/app-debug.apk',
    release,
    sizeKB: Math.round(fs.statSync(finalApk).size / 1024),
    totalMs: steps.reduce((a, s) => a + s.ms, 0),
    steps,
    install: install(),
  };
}

module.exports = { buildProject };
