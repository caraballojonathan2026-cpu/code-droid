/*
 * builder.js — the code-droid direct build pipeline. NO Gradle.
 *
 *   1. aapt2 compile  res/            -> res.zip
 *   2. aapt2 link     manifest + res  -> unsigned.apk + generated R.java
 *   3. kotlinc        *.kt (+R.java)  -> JVM classes      (against android.jar)
 *   4. d8             classes         -> classes.dex      (project code only!)
 *      d8 (cached)    kotlin-stdlib   -> classes2.dex     (dexed ONCE, then reused)
 *   5. zip            all *.dex       -> injected into unsigned.apk (native multidex)
 *   6. zipalign       4-byte align    -> aligned.apk
 *   7. apksigner      debug keystore  -> app-debug.apk
 *
 * Large-app strategy: the Kotlin standard library never changes between builds,
 * so its DEX is cached under <tools>/dex-cache/ (keyed by jar size + minSdk).
 * After the first build, recompiles only dex YOUR code — on big projects this
 * is the difference between ~30s and ~5s rebuilds.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function run(name, cmd, args, opts = {}) {
  const t0 = Date.now();
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, JAVA_OPTS: process.env.JAVA_OPTS || '-Xmx1536m' },
      ...opts,
    });
    return { name, ok: true, ms: Date.now() - t0, log: (out || '').trim() };
  } catch (e) {
    const log = `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message;
    return { name, ok: false, ms: Date.now() - t0, log };
  }
}

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (!ext || e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function dexShards(dir) {
  return fs.readdirSync(dir).filter((f) => /^classes(\d*)\.dex$/.test(f)).sort();
}

function ensureKeystore(tools, steps) {
  if (fs.existsSync(tools.keystore)) return true;
  fs.mkdirSync(path.dirname(tools.keystore), { recursive: true });
  if (tools.java && tools.java.keytool) {
    const s = run('keystore', tools.java.keytool, [
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

/* Dex kotlin-stdlib once per (jar, minSdk) and cache the shards. */
function ensureStdlibDex(T, minApi, toolsRoot, steps) {
  if (!T.kotlin.stdlib || !fs.existsSync(T.kotlin.stdlib)) return null;
  const st = fs.statSync(T.kotlin.stdlib);
  const key = `stdlib-${st.size}-${minApi}`;
  const cacheDir = path.join(toolsRoot, 'dex-cache', key);
  if (fs.existsSync(cacheDir) && dexShards(cacheDir).length) {
    steps.push({ name: 'd8 (kotlin-stdlib)', ok: true, ms: 0, log: 'cached ✔ (delete tools/dex-cache to rebuild)' });
    return cacheDir;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const s = run('d8 (kotlin-stdlib, one-time)', T.d8, ['--release', '--lib', T.sdk.androidJar,
    '--min-api', minApi, '--output', cacheDir, T.kotlin.stdlib]);
  steps.push(s);
  return s.ok ? cacheDir : null;
}

function buildProject(projectRoot, toolsInfo) {
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

  if (!fs.existsSync(manifest)) return { ok: false, error: 'No app/src/main/AndroidManifest.xml — is this a code-droid project?', steps: [] };

  fs.rmSync(buildDir, { recursive: true, force: true });
  for (const d of [buildDir, genDir, classesDir, projectDexDir, finalDexDir]) fs.mkdirSync(d, { recursive: true });

  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'code-droid.json'), 'utf8')); } catch { return {}; } })();
  const minApiNum = Math.max(Number(meta.minSdk) || 21, 21); // 21+ => native multidex (no main-dex list needed)
  const minApi = String(minApiNum);
  // Android 14+ refuses installs with targetSdk < 23; stamp a modern target, capped at our android.jar.
  const platformApi = (() => { const m = /android-(\d+)/.exec(T.sdk.platform || ''); return m ? Number(m[1]) : 33; })();
  const targetApi = String(Math.min(Number(meta.targetSdk || platformApi), platformApi));

  const steps = [];
  const step = (name, cmd, args, opts) => { const s = run(name, cmd, args, opts); steps.push(s); return s.ok; };
  const fail = (s) => ({ ok: false, steps: s, error: (s.filter((x) => !x.ok).pop() || {}).name + ' failed' });

  // 1) compile resources (optional for code-only UIs)
  if (fs.existsSync(resDir) && fs.readdirSync(resDir).length) {
    if (!step('aapt2 compile', T.aapt2, ['compile', '--dir', resDir, '-o', path.join(buildDir, 'res.zip')])) return fail(steps);
  }

  // 2) link: manifest + resources -> unsigned APK + R.java
  const linkArgs = ['link', '-o', unsignedApk, '-I', T.sdk.androidJar,
    '--manifest', manifest, '--java', genDir,
    '--min-sdk-version', minApi, '--target-sdk-version', targetApi];
  if (fs.existsSync(path.join(buildDir, 'res.zip'))) linkArgs.push(path.join(buildDir, 'res.zip'));
  if (!step('aapt2 link', T.aapt2, linkArgs)) return fail(steps);

  // 3) Kotlin compile (handles any number of files: we pass directories, not file lists)
  const ktRoots = [javaDir, path.join(srcMain, 'kotlin')].filter((d) => fs.existsSync(d) && walk(d, '.kt').length);
  if (!ktRoots.length) return fail(steps.concat([{ name: 'kotlinc', ok: false, ms: 0, log: 'No Kotlin sources under app/src/main/java' }]));
  const ktCount = ktRoots.reduce((n, d) => n + walk(d, '.kt').length, 0);
  const cp = [T.sdk.androidJar, T.kotlin.stdlib].filter(Boolean).join(path.delimiter);
  if (!step(`kotlinc (${ktCount} files)`, T.kotlin.bin, [...ktRoots, genDir, '-classpath', cp, '-d', classesDir])) return fail(steps);

  // 3b) compile generated R.java
  const genJava = walk(genDir, '.java');
  if (genJava.length && toolsInfo.tools.java.javac) {
    if (!step('javac (R.java)', toolsInfo.tools.java.javac, ['-cp', T.sdk.androidJar, '-d', classesDir, ...genJava])) return fail(steps);
  }

  // 4) DEX the project classes (jar first so argument lists stay short on huge projects)
  const classFiles = walk(classesDir, '.class');
  if (!classFiles.length) return fail(steps.concat([{ name: 'd8', ok: false, ms: 0, log: 'kotlinc produced no class files' }]));
  let d8Inputs;
  if (toolsInfo.tools.java.jar) {
    const jarPath = path.join(buildDir, 'classes.jar');
    if (!step('jar', toolsInfo.tools.java.jar, ['cf', jarPath, '-C', classesDir, '.'])) return fail(steps);
    d8Inputs = [jarPath];
  } else {
    d8Inputs = classFiles;
  }
  if (!step('d8 (project)', T.d8, ['--release', '--lib', T.sdk.androidJar, '--min-api', minApi, '--output', projectDexDir, ...d8Inputs])) return fail(steps);

  // 4b) cached stdlib dex
  const toolsRoot = path.dirname(toolsInfo.tools.keystore);
  const stdlibCache = ensureStdlibDex(T, minApi, toolsRoot, steps);
  if (stdlibCache === null && T.kotlin.stdlib) return fail(steps);

  // 5) assemble dex set: project shards are classes.dex.., stdlib shards follow (classes2.dex…)
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
  if (!step(`package ${dexPaths.length} dex`, T.zip, ['-j', unsignedApk, ...dexPaths])) return fail(steps);

  // 6) align
  if (!step('zipalign', T.zipalign, ['-f', '-p', '4', unsignedApk, alignedApk])) return fail(steps);

  // 7) sign with the debug key (auto-generated on first run)
  if (!ensureKeystore(toolsInfo.tools, steps)) return fail(steps);
  if (!step('apksigner', T.apksigner, ['sign', '--ks', toolsInfo.tools.keystore,
    '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', finalApk, alignedApk])) return fail(steps);
  step('verify', T.apksigner, ['verify', finalApk]);

  const size = fs.statSync(finalApk).size;
  return {
    ok: true,
    apk: 'build/app-debug.apk',
    sizeKB: Math.round(size / 1024),
    totalMs: steps.reduce((a, s) => a + s.ms, 0),
    steps,
    install: {
      adb: `adb install -r "${finalApk}"`,
      manual: 'Or copy the APK to your phone (USB, Drive, messaging) and tap it. Allow "install from unknown sources" when asked.',
    },
  };
}

module.exports = { buildProject };
