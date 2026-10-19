/*
 * toolchain.js — discovers the lightweight Android toolchain.
 *
 * code-droid replaces the Android Studio + Gradle stack (~10GB, multi-GB RAM)
 * with four direct command-line tools (~300MB total):
 *
 *   aapt2      compiles & links resources + AndroidManifest  (from build-tools)
 *   kotlinc    compiles Kotlin -> JVM bytecode               (Kotlin compiler dist)
 *   d8         bytecode -> DEX (classes.dex)                 (from build-tools)
 *   zipalign   aligns the APK                                (from build-tools)
 *   apksigner  signs the APK with a debug key                (from build-tools)
 *
 * Discovery order:
 *   1) CODE_DROID_TOOLS env var (dir containing kotlin/ and sdk/)
 *   2) <repo>/tools            (created by tools/install.sh)
 *   3) ANDROID_HOME / ANDROID_SDK_ROOT, ~/Android/Sdk  (reuse an existing SDK!)
 *   4) PATH lookups
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const REPO = path.resolve(__dirname, '..');

function exists(p) { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { try { fs.statSync(p); return true; } catch { return false; } } }
function onPath(cmd) {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).trim().split('\n')[0]; }
  catch { return null; }
}
function newestDir(dir, prefix) {
  try {
    const entries = fs.readdirSync(dir).filter((d) => d.startsWith(prefix)).sort();
    return entries.length ? path.join(dir, entries[entries.length - 1]) : null;
  } catch { return null; }
}

function findSdk() {
  const roots = [];
  const cdt = process.env.CODE_DROID_TOOLS;
  if (cdt) roots.push(path.join(cdt, 'sdk'));
  roots.push(path.join(REPO, 'tools', 'sdk'));
  if (process.env.ANDROID_HOME) roots.push(process.env.ANDROID_HOME);
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);
  roots.push(path.join(os.homedir(), 'Android', 'Sdk'));

  for (const root of roots) {
    const bt = newestDir(path.join(root, 'build-tools'), '');
    const platform = newestDir(path.join(root, 'platforms'), 'android-');
    if (bt && platform && exists(path.join(platform, 'android.jar'))) {
      return { root, buildTools: bt, platform, androidJar: path.join(platform, 'android.jar') };
    }
  }
  return null;
}

function findKotlinc() {
  const cdt = process.env.CODE_DROID_TOOLS;
  const roots = [];
  if (cdt) roots.push(path.join(cdt, 'kotlin'));
  roots.push(path.join(REPO, 'tools', 'kotlin'));
  for (const root of roots) {
    for (const prefix of ['kotlin-compiler', 'kotlinc']) {
      const dir = newestDir(root, prefix);
      if (!dir) continue;
      const bin = path.join(dir, 'bin', process.platform === 'win32' ? 'kotlinc.bat' : 'kotlinc');
      if (exists(bin)) return { bin, home: dir, stdlib: path.join(dir, 'lib', 'kotlin-stdlib.jar') };
    }
  }
  const bin = onPath('kotlinc');
  if (bin) {
    const home = path.resolve(path.dirname(bin), '..');
    return { bin, home, stdlib: path.join(home, 'lib', 'kotlin-stdlib.jar') };
  }
  return null;
}

function findJava() {
  const java = onPath('java');
  const javac = onPath('javac');
  const jar = onPath('jar');
  let keytool = onPath('keytool');
  let jarTool = jar;
  if (java) {
    const binDir = path.dirname(fs.realpathSync(java));
    if (!keytool) { const kt = path.join(binDir, 'keytool'); if (exists(kt)) keytool = kt; }
    if (!jarTool) { const j = path.join(binDir, 'jar'); if (exists(j)) jarTool = j; }
  }
  return java ? { java, javac, jar: jarTool, keytool } : null;
}

function discoverTools() {
  const sdk = findSdk();
  const kotlin = findKotlinc();
  const java = findJava();
  const keystore = defaultKeystorePath();

  const tools = {
    java,
    kotlin,
    sdk,
    aapt2: sdk ? path.join(sdk.buildTools, 'aapt2') : null,
    d8: sdk ? path.join(sdk.buildTools, 'd8') : null,
    zipalign: sdk ? path.join(sdk.buildTools, 'zipalign') : null,
    apksigner: sdk ? path.join(sdk.buildTools, 'apksigner') : null,
    zip: onPath('zip'),
    keystore,
  };

  const missing = [];
  if (!java || !java.java) missing.push('java (JDK 11+)');
  if (!kotlin) missing.push('kotlinc (Kotlin compiler)');
  if (!sdk) missing.push('Android SDK pieces (build-tools + platform): run tools/install.sh');
  if (!tools.zip) missing.push('zip');

  return {
    ready: missing.length === 0,
    missing,
    tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, (typeof v === 'object' && v !== null) ? v : (v || null)])),
    installHint: 'bash tools/install.sh',
  };
}

function defaultKeystorePath() {
  const cdt = process.env.CODE_DROID_TOOLS;
  const base = cdt || path.join(REPO, 'tools');
  return path.join(base, 'debug.keystore');
}

module.exports = { discoverTools, defaultKeystorePath };
