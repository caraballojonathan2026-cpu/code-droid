# code-droid architecture

## Design goals

1. **Run on 4 GB RAM.** Every component replaces a heavyweight standard piece with the
   lightest thing that still does the real job.
2. **Scale to big projects.** Small-project conveniences must not collapse at 100K lines.
3. **No moving parts you can't see.** The build is explicit commands; the IDE is static files.
4. **Zero npm/JS dependencies.** `npm install` is a no-op; startup is instant.

## Components

### Web IDE (`web/`, ~200 KB)

| Standard choice | code-droid choice | Why |
|---|---|---|
| Monaco editor (~3.5 MB) | overlay editor: transparent `<textarea>` over a highlighted `<pre>` + line-number gutter | ~60 lines of CSS/JS, instant, smooth |
| tree-sitter / TextMate | single-pass regex tokenizer (`kotlin.js`) | no wasm, sub-ms for typical files |
| React/Vue SPA | vanilla JS + `fetch` | no build step for the IDE itself |

**Scaling the editor (v0.2).** Two regimes, chosen per keystroke by file size:

- *Normal* (< 120 KB): the whole document is re-highlighted per frame — sub-millisecond.
- *Viewport mode* (≥ 120 KB): the hidden `<pre>` holds the full text, but only the
  visible window (±150 lines) is passed through the tokenizer; everything else is just
  HTML-escaped. Because the font is monospace, unstyled text has identical metrics, so
  scrolling and caret alignment stay pixel-perfect while CPU per keystroke is O(window),
  not O(file). Line cache invalidates on edit. Files > 2 MB open read-only.

**Never losing work.** Every edit is debounced (0.4 s) into `localStorage` as
`{content, diskMtime, timestamp}` keyed per file. On open: matching mtime ⇒ restore the
draft automatically (banner offers Save/Discard); mismatched ⇒ show disk, offer
"Use my draft". Open tabs, active file, expanded folders, project and console state are
persisted the same way, so `⟳ Restart` + reload is a pure no-op for the user.

**Navigation.** Ctrl+P quick-open scores files by subsequence matching over a flattened
tree (no server round trip). Ctrl+Shift+F hits `GET /api/search`, and results are clickable
rows that open the file at the exact line.

### Server (`server/`, Node ≥ 16, zero deps)

- `launcher.js` — ~30-line supervisor. `npm start` runs it; it respawns `server.js`
  whenever it exits with code **75** — which is exactly what `POST /api/restart` does.
  This is how a stateless-looking web UI can restart its own backend.
- `server.js` — static files + JSON API: projects, tree, file read/write (returns
  `mtime` for draft conflict detection), create/delete, `/api/search`,
  `/api/project/export` (zip, excludes `build/`), `/api/project/import` (zip upload →
  unique project id), `/api/build`, `/api/apk`, `/api/restart`. Single-flight build lock.
- `store.js` — projects under `projects/`; all paths resolved + verified inside the
  project; iterative (non-recursive) full-text search over text extensions, skipping
  `build/`, dotfiles, and >1 MB files, capped at 300 results.
- `toolchain.js` — discovery order: `CODE_DROID_TOOLS` → `tools/` → `ANDROID_HOME` →
  `~/Android/Sdk` → `$PATH`. Newest `build-tools/*` and `platforms/android-*` win.
- `builder.js` — the pipeline (below).

### The direct build pipeline

```
res/ ──► aapt2 compile ──► res.zip ─┐
AndroidManifest.xml ────────────────┼─► aapt2 link ─► unsigned.apk + gen/R.java
android.jar ────────────────────────┘         │
kt dirs ─► kotlinc (-cp android.jar) ─► classes ─► d8 ──► classes*.dex   (project)
                                        kotlin-stdlib ─► d8 (CACHED) ──► classesN.dex
unsigned.apk ◄── zip -j unsigned.apk <all shards> ◄───────┘
──► zipalign -f -p 4 ─► apksigner (debug key) ─► app-debug.apk
```

Notes:

- **stdlib dex cache.** `kotlin-stdlib.jar` is constant per project SDK level, so its dex
  shards live under `tools/dex-cache/stdlib-<size>-<minSdk>/` and are reused forever.
  Rebuilds only re-dex project code (~1–2 s instead of ~10 s). `minSdk` is floored at 21
  ⇒ native multidex ⇒ no legacy main-dex list needed.
- **Big projects.** kotlinc receives *source directories* (`app/src/main/java`), not
  5,000 individual paths; class files are jarred before d8 for the same reason.
  `JAVA_OPTS` heap cap defaults to `-Xmx1536m` (override per machine).
- **R.java** from `aapt2 link --java` is compiled by `javac` (kotlinc resolves symbols
  from it; javac deterministically emits its bytecode).
- **Debug keystore** once via `keytool`, `tools/debug.keystore`, password `android`.
- **targetSdk** is stamped by aapt2 (`--target-sdk-version`) capped at the platform
  android.jar, so APKs install on Android 14+ (which rejects targetSdk < 23).

## Threat model / safety

- Path traversal: every file API resolves against the project root and rejects escapes;
  `build/` is server-managed and not writable through the API.
- No shell interpolation with user input anywhere (`execFileSync` with fixed argv arrays).
- Zip import is size-limited (64 MB) and unpacked into a temp dir before becoming a project.
- The debug key is for development only — never ship releases signed with it.

## Why this is enough (and when it isn't)

Framework `Activity` + Views cover a lot: UIs in Kotlin, intents, sensors, storage,
network, media. The moment you need AndroidX/Compose/NDK, code-droid grows an opt-in
module rather than getting heavier for everyone — see the roadmap.
