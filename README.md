# 🤖 code-droid

**The light Android IDE.** Write Kotlin in your browser, compile real APKs, and run them on a real phone — on a laptop with **4 GB of RAM**. No Android Studio. No Gradle. No emulator.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Your browser (any OS)      │        │  code-droid server (Node.js) │
│  ┌───────────────────────┐  │  HTTP  │  file store + build runner   │
│  │ code-droid web IDE    │◄─┼────────┤  aapt2 → kotlinc → d8        │
│  │ • Kotlin highlighting │  │  JSON  │  → zipalign → apksigner      │
│  │ • file tree & tabs    │  │        │           │                  │
│  │ • one-click APK build │  │        │           ▼                  │
│  └───────────────────────┘  │        │      app-debug.apk  ──► 📱   │
└─────────────────────────────┘        └──────────────────────────────┘
     ≈ 150 KB of HTML/CSS/JS              ≈ 300 MB toolchain, ~100 MB RAM server
```

## Why?

| | Android Studio way | code-droid way |
|---|---|---|
| Disk footprint | ~8–12 GB (IDE + SDK + emulator images) | **~300 MB** |
| RAM while coding | 2–4 GB (IDE + Gradle daemon) | **a browser tab + ~100 MB** |
| RAM while building | 1.5–3 GB (Gradle + AGP + Kotlin daemon) | **~0.5 GB** (direct tools, no daemons) |
| Test device | bundled x86 emulator (very heavy) | **your real phone** (USB or APK transfer) |
| Stack | IDE + Gradle + AGP + Kotlin plugin + emulator | one Node script + 5 command-line tools |

Android Studio is great — it's just too big for old laptops, Chromebooks, classrooms and low-end machines. code-droid keeps the part that matters (write Kotlin → get an APK) and deletes the rest.

## Quick start

```bash
git clone https://github.com/YOUR-USERNAME/code-droid.git
cd code-droid

# 1. one-time toolchain download (~300MB: Kotlin compiler, build-tools, android.jar)
bash tools/install.sh

# 2. start the IDE (needs Node.js 16+, needs NOTHING else)
npm start

# 3. open http://localhost:3000 — the "hello-droid" sample is already there
```

Press **▶ Build APK** → watch the 7-step pipeline in the console → **⬇ APK**.

### Install the app on your phone (no emulator!)

1. **USB + adb** (nicest): enable *Developer options → USB debugging* on the phone, then
   `adb install -r projects/hello-droid/build/app-debug.apk`
2. **Or just copy the APK**: send it to the phone (USB cable, Google Drive, Telegram/WhatsApp to yourself…), tap it, allow *install unknown apps* once.

Either way you get a real app with an icon in the launcher: **Hello Droid**.

## What's inside

```
code-droid/
├── server/            zero-dependency Node.js backend (~100MB RAM)
│   ├── server.js      HTTP + JSON API
│   ├── builder.js     the direct build pipeline (NO Gradle)
│   ├── toolchain.js   finds kotlinc / build-tools / android.jar (or your existing SDK)
│   └── store.js       projects & files, path-traversal safe
├── web/               the IDE — plain HTML/CSS/JS, ~150KB total
│   ├── index.html     layout (top bar, tree, editor, build console)
│   ├── style.css      Darcula-inspired dark theme
│   ├── kotlin.js      hand-rolled Kotlin/XML syntax highlighter
│   └── app.js         tabs, autosave-on-build, console, APK download
├── templates/hello/   sample Kotlin app ("Hello Droid") without any Gradle files
├── tools/install.sh   downloads the ~300MB toolchain as plain zips
└── docs/ARCHITECTURE.md
```

### The build pipeline (what Gradle hides from you, step by step)

1. `aapt2 compile` — resources → flat archive
2. `aapt2 link` — manifest + resources + `android.jar` → unsigned APK + `R.java`
3. `kotlinc` — your Kotlin → JVM bytecode
4. `d8` — bytecode + kotlin-stdlib → `classes.dex`
5. `zip` — inject the dex into the APK
6. `zipalign` — 4-byte alignment (required by Android)
7. `apksigner` — sign with an auto-generated debug key → **installable APK**

Every step prints its timing in the build console, so you can *see* where the seconds go (spoiler: mostly kotlinc's JVM startup; still seconds, not minutes).

## Project layout (a code-droid app)

A project is just a folder — if you know Android's `src/main` convention you're home:

```
my-app/
├── code-droid.json                    { "appName", "applicationId", "minSdk": 21 }
└── app/src/main/
    ├── AndroidManifest.xml
    ├── java/com/example/myapp/MainActivity.kt
    └── res/values/strings.xml         (optional — UIs can be pure Kotlin code)
```

## Current limits (honest list) & roadmap

This is a young project. Today it intentionally does **not** support: AndroidX/Jetpack libraries, Jetpack Compose, AAR dependencies, native code (NDK), resource shrinking, release signing UI, or the emulator. What's planned:

- [ ] Live/streaming build logs (SSE)
- [ ] More templates (list app, sensor app, camera intents)
- [ ] Wireless ADB pairing from the browser (WebUSB)
- [ ] Optional `kotlin-language-server` for autocomplete (heavier — opt-in)
- [ ] AndroidX support via Maven AAR fetching (opt-in, cached)
- [ ] Release-keystore signing UI
- [ ] PWA mode so the IDE works offline

**Contributions very welcome** — the whole codebase is deliberately small and dependency-free.

## FAQ

**Is the APK "real"?** Yes — same tools Android Studio calls under the hood (`aapt2`, `d8`, `apksigner`), just without Gradle orchestrating them.

**Can I use my existing Android SDK instead of downloading?** Yes: set `ANDROID_HOME` (or drop a `build-tools` + `platforms` folder into `tools/sdk/`) and install.sh will skip what's already there — only Kotlin is fetched.

**Why no emulator?** On a 4GB machine an emulator is what makes everything lag. Real phones are faster, free, and already in your pocket.

**Does it need internet?** Only once, for `tools/install.sh`. After that, coding and building are fully offline.

**Server on another machine?** Sure — run `HOST=0.0.0.0 npm start` on a beefier box and code from a tablet/Chromebook. (No auth yet; LAN-only, please.)

## License

MIT — see [LICENSE](LICENSE).
