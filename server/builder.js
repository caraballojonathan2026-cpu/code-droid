/*
 * builder.js — the code-droid direct build pipeline. NO Gradle.
 *
 *   1. aapt2 compile  res/            -> res.zip
 *   2. aapt2 link     manifest + res  -> unsigned.apk + generated R.java
 *   3. kotlinc        *.kt (+R.java)  -> JVM classes      (against android.jar)
 *   4. d8             classes+stdlib  -> classes.dex      (with desugaring)
 *   5. zip            classes.dex     -> injected into unsigned.apk
 *   6. zipalign       4-byte align    -> aligned.apk
 *   7. apksigner      debug keystore  -> app-debug.apk  (ready to install!)
 *
 * A hello-world APK builds in seconds with roughly 10x less RAM than a
 * Gradle-based build, and there is no daemon sitting around afterwards.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function run(name, cmd, args, opts = {}) {
  const t0 = Date.now();
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, JAVA_OPTS: process.env.JAVA_OPTS || '-Xmx1024m' },
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

function buildProject(projectRoot, toolsInfo) {
  if (!toolsInfo.ready) {
    return {
      ok: false,
      stage: 'toolchain',
      missing: toolsInfo.missing,
      error: 'Toolchain incomplete. Run: ' + toolsInfo.installHint,
      steps: [],
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
  const dexDir = path.join(buildDir, 'dex');
  const unsignedApk = path.join(buildDir, 'unsigned.apk');
  const alignedApk = path.join(buildDir, 'aligned.apk');
  const finalApk = path.join(buildDir, 'app-debug.apk');

  if (!fs.existsSync(manifest)) return { ok: false, error: 'No app/src/main/AndroidManifest.xml — is this a code-droid project?', steps: [] };

  fs.rmSync(buildDir, { recursive: true, force: true });
  for (const d of [buildDir, genDir, classesDir, dexDir]) fs.mkdirSync(d, { recursive: true });

  const meta = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'code-droid.json'), 'utf8')); } catch { return {}; } })();
  const minApi = String(meta.minSdk || 21);
  // Android 14+ refuses to install apps whose targetSdk < 23, so always stamp a
  // modern targetSdk — capped at the android.jar we compile against.
  const platformApi = (() => { const m = /android-(\d+)/.exec(T.sdk.platform || ''); return m ? Number(m[1]) : 33; })();
  const targetApi = String(Math.min(Number(meta.targetSdk || platformApi), platformApi));

  const steps = [];
  const step = (name, cmd, args, opts) => { const s = run(name, cmd, args, opts); steps.push(s); return s.ok; };

  // 1) compile resources (res/ is optional for code-only UIs)
  if (fs.existsSync(resDir) && fs.readdirSync(resDir).length) {
    if (!step('aapt2 compile', T.aapt2, ['compile', '--dir', resDir, '-o', path.join(buildDir, 'res.zip')])) return fail(steps);
  }

  // 2) link: manifest + resources -> unsigned APK + R.java
  const linkArgs = ['link', '-o', unsignedApk, '-I', T.sdk.androidJar,
    '--manifest', manifest, '--java', genDir,
    '--min-sdk-version', minApi, '--target-sdk-version', targetApi];
  if (fs.existsSync(path.join(buildDir, 'res.zip'))) linkArgs.push(path.join(buildDir, 'res.zip'));
  if (!step('aapt2 link', T.aapt2, linkArgs)) return fail(steps);

  // 3) Kotlin compile (project sources; gen dir passed for R symbol resolution)
  const ktRoots = [javaDir, path.join(srcMain, 'kotlin')].filter((d) => fs.existsSync(d));
  if (!ktRoots.length) return fail(steps.concat([{ name: 'kotlinc', ok: false, ms: 0, log: 'No Kotlin sources under app/src/main/java' }]));
  const cp = [T.sdk.androidJar, T.kotlin.stdlib].filter(Boolean).join(path.delimiter);
  if (!step('kotlinc', T.kotlin.bin, [...ktRoots, genDir, '-classpath', cp, '-d', classesDir])) return fail(steps);

  // 3b) compile generated R.java with javac (needed when resources exist)
  const genJava = walk(genDir, '.java');
  if (genJava.length && toolsInfo.tools.java.javac) {
    if (!step('javac (R.java)', toolsInfo.tools.java.javac, ['-cp', T.sdk.androidJar, '-d', classesDir, ...genJava])) return fail(steps);
  }

  // 4) DEX: jar classes, then d8 (bundle kotlin-stdlib so Kotlin just works)
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
  if (T.kotlin.stdlib && fs.existsSync(T.kotlin.stdlib)) d8Inputs.push(T.kotlin.stdlib);
  if (!step('d8', T.d8, ['--release', '--lib', T.sdk.androidJar, '--min-api', minApi, '--output', dexDir, ...d8Inputs])) return fail(steps);

  // 5) inject classes.dex into the APK (a plain zip operation)
  if (!step('package dex', T.zip, ['-j', unsignedApk, path.join(dexDir, 'classes.dex')])) return fail(steps);

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

  function fail(s) {
    return { ok: false, steps: s, error: (s.filter((x) => !x.ok).pop() || {}).name + ' failed' };
  }
}

module.exports = { buildProject };
