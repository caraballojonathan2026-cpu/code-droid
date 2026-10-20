# 🤖 code-droid

**The light Android IDE.** Write Kotlin in your browser, compile real APKs, and run them on a real phone — on a laptop with **4 GB of RAM**. No Android Studio. No Gradle. No emulator.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Your browser (any OS)      │        │  code-droid server (Node.js) │
│  ┌───────────────────────┐  │  HTTP  │  file store + build runner   │
│  │ code-droid web IDE    │◄─┼────────┤  aapt2 → kotlinc → d8        │
│  │ • Kotlin highlighting │  │  JSON  │  → zipalign → apksigner      │
│  │ • Ctrl+P, Ctrl+Shift+F│  │        │  (+ cached stdlib dex)       │
│  │ • autosave to browser │  │        │           │                  │
│  └───────────────────────┘  │        │           ▼                  │
└─────────────────────────────┘        │      app-debug.apk  ──► 📱   │
     ≈ 200 KB of HTML/CSS/JS           └──────────────────────────────┘
                                        ≈ 300 MB toolchain, ~100 MB RAM
```

## Why?

| | Android Studio way | code-droid way |
|---|---|---|
| Disk footprint | ~8–12 GB (IDE + SDK + emulator images) | **~300 MB** |
| RAM while coding | 2–4 GB (IDE + Gradle daemon) | **a browser tab + ~100 MB** |
| RAM while building | 1.5–3 GB (Gradle + AGP + Kotlin daemon) | **~0.5 GB** (direct tools, no daemons) |
| Rebuild after a change | tens of seconds (task graph, config cache) | **~7 s** warm (stdlib dex is cached) |
| Test device | bundled x86 emulator (very heavy) | **your real phone** (USB or APK transfer) |

Measured in a **1.9 GB RAM / 2 CPU** sandbox: a **201-file Kotlin app** builds in ~24 s, hello world in ~8 s warm, re-tapping Build with no changes answers **“up to date” in ~3 ms** — and the IDE stays snappy the whole time because builds never freeze the server. Numbers live in `npm test`.

## Quick start

```bash
git clone https://github.com/YOUR-USERNAME/code-droid.git
cd code-droid

# 0. sanity check your machine (Node 16+, JDK 11+, zip/unzip, curl)
npm run doctor

# 1. one-time toolchain download (~300MB: Kotlin compiler, build-tools, android.jar)
bash tools/install.sh

# 2. start the IDE (needs Node.js 16+, needs NOTHING else)
npm start     # supervisor + server — enables the in-IDE ⟳ restart button

# 3. open http://localhost:3000 — the "hello-droid" sample is already there
```

Press **▶ Build APK** → watch the pipeline in the console → **⬇ APK** downloads straight to your Downloads folder.
Check the compiler any time with **`npm test`** (self-test builds the sample and verifies the signature) and the UI with **`npm run smoke`**.

## The top bar, button by button

Left to right, everything on the top bar:

| Control | What it does |
|---|---|
| **🤖 code-droid `v…`** | The logo shows the running **version** — if a feature looks missing, check you're on the version you think you are. |
| **● tools badge** | Toolchain health: 🟢 **ready** = `aapt2`, `kotlinc`, `d8`, `apksigner` all found → you can build. 🔴 **missing** → run `bash tools/install.sh` (or `npm run doctor` to see exactly what's absent). |
| **Project picker ▾** | Switch between projects. Your last choice is remembered across restarts. |
| **＋ Project** | Create a new project from the built-in *hello* template (asks for a name, starts with a working MainActivity). |
| **＋ File** | Create a single file (asks for the path). *Tip: for nested paths or deleting things, 📄± is faster.* |
| **💾 Save** | Writes the current file to disk (`Ctrl+S`). Not strictly needed — every keystroke is also auto-backed-up to the browser — but Save makes it permanent (and Commit puts it in git). |
| **▶ Build APK** | Runs the direct pipeline `aapt2 → kotlinc ‖ javac → d8 → zipalign → apksigner → verify` and narrates every step (with timings) in the bottom console. If nothing changed since the last build it answers *“APK up to date”* in ~1 ms. |
| **⬇ APK** | Appears after a build. Downloads the **signed** debug APK (also copied to `releases/<project>-debug.apk`). If the browser blocks the download, a panel offers *open in new tab / copy link* fallbacks. |
| **⎇ Commit** | GitHub-style commit for the project: the dialog lists the changed files, asks for a message (+ optional description), saves every open file and creates the commit. If the folder isn't a git repo yet, it runs `git init` and this becomes the first commit. |
| **⇧ Import** | Upload a project from a `.zip` (name conflicts are auto-renamed). Useful together with… |
| **⇩ Export** | …which downloads the whole project as a `.zip` (build output excluded). They're how you move work between machines. |
| **⟳** | Restart the code-droid server itself (works because `npm start` runs a tiny supervisor). The page reloads afterwards; unsaved work survives in localStorage. |
| **📄±** | The *power* file dialog: type any full path with `/` slashes — e.g. `app/src/main/java/com/example/hellodroid/Utils.kt` — and create the file, create it as a folder, or **delete** it. Missing folders in between are created automatically. `Enter` = create file. |
| **?** | Help & shortcuts: why it's light, how your work is protected, phone-install steps, and the keyboard cheat sheet. |

Things you *won't* find there by design: **search has no button** (use `Ctrl+P` to jump to a file or `Ctrl+Shift+F` to grep the project), and half the UI is on **right-click** — explorer, editor and tabs all have VS Code-style context menus.

## Feature tour

**Built for big projects**
- 🔍 **Ctrl+P** quick-open any file; **Ctrl+Shift+F** project-wide search with clickable results that jump to the exact line
- **Instant rebuilds**: an input signature (path+size+mtime of every source) answers “APK up to date” in milliseconds when nothing changed; **builds run async** (the IDE/server never freeze; `kotlinc` and `javac` even run in parallel)
- **Cached stdlib DEX**: kotlin-stdlib is dexed once ever; rebuilds only dex *your* code
- Editor uses a *viewport highlighter* + **virtualized line-number gutter**: only visible lines are colorized/numbered, so 500K-line files stay smooth; >2 MB files open read-only, >8 MB are refused
- **VS Code-style Explorer** that stays fast at 10K+ files: server-side cached tree, lazy render (200 per folder with “… more” paging), collapsible root, sizes in tooltips, **Ctrl+B** to hide it entirely
- Builds pass *directories* to kotlinc/d8 (not file lists) — no command-length limits on huge projects

**Never lose work**
- Every keystroke is backed up to **localStorage** after 0.4 s; close the tab, crash, restart the server — reopen and unsaved changes are restored with a banner (save or discard)
- Remembers open tabs, active file, expanded folders, selected project, console state
- Unsaved tabs you *close* also keep a draft copy

**Self-contained workflow**
- **Right-click everywhere** (VS Code style): explorer → new file/folder, rename, delete, download file; editor → save, cut/copy/paste, select all, go-to-line, build; tabs → close / close others / copy path
- **📄± file dialog** (next to `?`): type any path with `/` slashes — nested folders are created automatically; delete files or whole folders from the same place
- **⎇ Commit button** (GitHub-style): dialog shows changed files for the project, asks for a message (+ optional description), saves all files and commits — runs `git init` automatically if the folder wasn't a repo yet
- **⇩ Export** — download the whole project as a .zip (build output excluded)
- **⇧ Import** — drop in a .zip, it becomes a project (name conflicts auto-renamed)
- **⟳ Restart** — respawn the server from the UI (works because `npm start` runs a tiny supervisor); the page reloads and your work is still there
- Project picker, "＋ Project" from template, "＋ File", dark Darcula theme, Android-green accent

### Install the app on your phone (no emulator!)

1. **USB + adb** (nicest): enable *Developer options → USB debugging* on the phone, then
   `adb install -r projects/hello-droid/build/app-debug.apk`
2. **Or just copy the APK**: send it to the phone (USB cable, Google Drive, chat…), tap it, allow *install unknown apps* once.

## What's inside

```
code-droid/
├── server/            zero-dependency Node.js backend
│   ├── launcher.js    supervisor — respawns the server for the ⟳ button
│   ├── server.js      HTTP + JSON API (files, search, build, import/export, restart)
│   ├── builder.js     the direct build pipeline + stdlib dex cache (NO Gradle)
│   ├── toolchain.js   finds kotlinc / build-tools / android.jar (or your existing SDK)
│   └── store.js       projects, files, full-text search — path-traversal safe
├── web/               the IDE — plain HTML/CSS/JS, ~200KB total
│   ├── index.html     top bar, tree, editor+line numbers, console, quick-open, search, banners
│   ├── style.css      Darcula-inspired dark theme
│   ├── kotlin.js      hand-rolled Kotlin/XML syntax highlighter
│   └── app.js         viewport rendering, drafts, quick-open, search, import/export, restart
├── templates/hello/   sample Kotlin app ("Hello Droid") without any Gradle files
├── tools/install.sh   downloads the ~300MB toolchain as plain zips
├── tools/selftest.js  npm test — proves the whole compiler pipeline works
└── docs/ARCHITECTURE.md
```

### The build pipeline (what Gradle hides from you)

1. `aapt2 compile` — resources → flat archive
2. `aapt2 link` — manifest + resources + `android.jar` → unsigned APK + `R.java`
3. `kotlinc` — your Kotlin → JVM bytecode
4. `d8` — your bytecode → `classes.dex` **+ cached** kotlin-stdlib → `classes2.dex` (native multidex)
5. `zip` — inject all dex shards into the APK
6. `zipalign` — 4-byte alignment
7. `apksigner` — sign with an auto-generated debug key → **installable APK**

## Project layout (a code-droid app)

```
my-app/
├── code-droid.json                    { "appName", "applicationId", "minSdk": 21 }
└── app/src/main/
    ├── AndroidManifest.xml            (versionCode/versionName live here)
    ├── java/com/example/myapp/*.kt    (as many files as you like)
    └── res/values/strings.xml         (optional — UIs can be pure Kotlin code)
```

## Current limits (honest list) & roadmap

Not yet: AndroidX/Jetpack libraries, Jetpack Compose, AAR dependencies, NDK, resource shrinking (R8), release signing UI, emulator. Planned:

- [ ] Live/streaming build logs (SSE)
- [ ] More templates (list app, sensor app, multi-activity)
- [ ] Wireless ADB install from the browser
- [ ] Optional `kotlin-language-server` autocomplete (opt-in; heavier)
- [ ] AndroidX support via cached Maven AAR fetching (opt-in)
- [ ] Release-keystore signing UI

**Contributions welcome** — the codebase is deliberately small and dependency-free.

## FAQ

**Is the APK "real"?** Yes — same tools Android Studio calls under the hood (`aapt2`, `d8`, `apksigner`), just without Gradle orchestrating them.

**Can I use my existing Android SDK?** Yes: set `ANDROID_HOME`, and `install.sh` fetches only Kotlin.

**Why no emulator?** On a 4GB machine the emulator is what makes everything lag. Your real phone is faster, free, and already in your pocket.

**Offline?** Only `tools/install.sh` needs internet, once. Coding/building work fully offline; unsaved work lives in the browser.

**Server on another machine?** Yes — `HOST=0.0.0.0 npm start` on a beefier box, code from a tablet/Chromebook. (No auth yet; LAN-only, please.)

## License

MIT — see [LICENSE](LICENSE).
