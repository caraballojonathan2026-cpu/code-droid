#!/usr/bin/env bash
#
# code-droid toolchain installer — downloads ONLY what a build needs (~300MB),
# straight from Google/JetBrains as plain zips. No sdkmanager, no Android Studio.
#
#   tools/sdk/build-tools/   aapt2, d8, zipalign, apksigner
#   tools/sdk/platforms/     android-34/android.jar
#   tools/kotlin/            kotlinc + kotlin-stdlib
#
# Override the install location with:  CODE_DROID_TOOLS=/some/dir bash tools/install.sh
#
set -euo pipefail

DEST="${CODE_DROID_TOOLS:-$(cd "$(dirname "$0")" && pwd)}"
SDK="$DEST/sdk"
KOTLIN_DIR="$DEST/kotlin"
mkdir -p "$SDK/build-tools" "$SDK/platforms" "$KOTLIN_DIR"

OS="linux"
[ "$(uname -s)" = "Darwin" ] && OS="mac"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v java   >/dev/null || die "java (JDK 11+) not found. Install a JDK first (e.g. 'sudo apt install openjdk-17-jdk-headless')."
command -v unzip  >/dev/null || die "unzip not found (e.g. 'sudo apt install unzip')."
DL=""
if command -v curl >/dev/null; then DL="curl -fL --retry 3 -o";
elif command -v wget >/dev/null; then DL="wget -O";
else die "need curl or wget"; fi

fetch() { # fetch <url> <outfile> ; returns non-zero on 404
  local url="$1" out="$2"
  say "Downloading $(basename "$out")"
  $DL "$out" "$url" 2>>/dev/null || $DL "$out" "$url" || return 1
}

# ---- 1) Android build-tools (aapt2, d8, zipalign, apksigner) ----
if ! ls "$SDK"/build-tools/*/aapt2 >/dev/null 2>&1; then
  ok=""
  for v in 34.0.0 35.0.0 33.0.1; do
    major="${v%%.*}"
    if [ "$OS" = "mac" ]; then url="https://dl.google.com/android/repository/build-tools_r${major}-macosx.zip"
    else url="https://dl.google.com/android/repository/build-tools_r${major}-linux.zip"; fi
    if fetch "$url" "$DEST/build-tools.zip"; then ok="$v"; break; fi
  done
  [ -n "$ok" ] || die "could not download build-tools"
  tmp="$DEST/__bt"; rm -rf "$tmp"; mkdir -p "$tmp"
  unzip -q "$DEST/build-tools.zip" -d "$tmp"
  inner="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d | head -1)"
  mkdir -p "$SDK/build-tools/$ok"
  cp -r "$inner"/. "$SDK/build-tools/$ok/"
  rm -rf "$tmp" "$DEST/build-tools.zip"
  chmod +x "$SDK/build-tools/$ok/aapt2" "$SDK/build-tools/$ok/d8" "$SDK/build-tools/$ok/zipalign" "$SDK/build-tools/$ok/apksigner" 2>/dev/null || true
  say "build-tools $ok installed"
else
  say "build-tools already present"
fi

# ---- 2) Android platform (android.jar — the API to compile against) ----
if [ ! -f "$SDK/platforms/android-34/android.jar" ]; then
  ok=""
  for v in "34_r03" "34_r02" "34_r01" "33_r02"; do
    api="${v%%_*}"
    if fetch "https://dl.google.com/android/repository/platform-${v}.zip" "$DEST/platform.zip"; then ok="$api"; break; fi
  done
  [ -n "$ok" ] || die "could not download an android platform"
  tmp="$DEST/__pl"; rm -rf "$tmp"; mkdir -p "$tmp"
  unzip -q "$DEST/platform.zip" -d "$tmp"
  inner="$(find "$tmp" -name android.jar | head -1)"
  [ -n "$inner" ] || die "android.jar missing in platform zip"
  mkdir -p "$SDK/platforms/android-$ok"
  cp "$(dirname "$inner")"/android.jar "$SDK/platforms/android-$ok/android.jar"
  rm -rf "$tmp" "$DEST/platform.zip"
  say "platform android-$ok installed"
else
  say "platform already present"
fi

# ---- 3) Kotlin compiler ----
if [ ! -x "$KOTLIN_DIR/kotlinc/bin/kotlinc" ]; then
  ok=""
  for v in 2.0.21 2.0.0 1.9.24; do
    if fetch "https://github.com/JetBrains/kotlin/releases/download/v${v}/kotlin-compiler-${v}.zip" "$DEST/kotlin.zip"; then ok="$v"; break; fi
  done
  [ -n "$ok" ] || die "could not download the Kotlin compiler"
  tmp="$DEST/__kt"; rm -rf "$tmp"; mkdir -p "$tmp"
  unzip -q "$DEST/kotlin.zip" -d "$tmp"
  mv "$tmp/kotlinc" "$KOTLIN_DIR/kotlinc"
  rm -rf "$tmp" "$DEST/kotlin.zip"
  chmod +x "$KOTLIN_DIR/kotlinc/bin/"* 2>/dev/null || true
  say "Kotlin $ok installed"
else
  say "Kotlin compiler already present"
fi

cat <<EOF

$(say 'Toolchain ready!') Total size: $(du -sh "$DEST" | cut -f1) (vs ~10GB for Android Studio + SDK)

Next:
  npm start            # or: node server/server.js
  open http://localhost:3000

EOF
