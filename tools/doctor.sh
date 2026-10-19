#!/usr/bin/env bash
#
# code-droid doctor — verifies your machine is ready before you start.
# Checks the few things code-droid needs and prints exact fixes for what's missing.
#
#   npm run doctor     (or: bash tools/doctor.sh)
#
set -u
ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[1;31m✖\033[0m %s\n' "$*"; FAIL=1; }
warn() { printf '  \033[1;33m⚠\033[0m %s\n' "$*"; }
FAIL=0
DEST="${CODE_DROID_TOOLS:-$(cd "$(dirname "$0")" && pwd)}"

echo "code-droid doctor"
echo "================="
echo

echo "[ runtime ]"
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
  if [ "$MAJOR" -ge 16 ]; then ok "node $(node -v) (16+ required)"; else bad "node $(node -v) is too old — need 16+  → https://nodejs.org"; fi
else
  bad "node not found  → install Node.js 16+ (https://nodejs.org or 'sudo apt install nodejs')"
fi
if command -v javac >/dev/null 2>&1; then ok "JDK present (javac found) — needed for R.java + signing"; else bad "javac not found — install a JDK 11+  → 'sudo apt install openjdk-17-jdk-headless'"; fi

echo
echo "[ shell tools ]"
if command -v zip >/dev/null 2>&1; then ok "zip"; else bad "zip missing  → 'sudo apt install zip'"; fi
if command -v unzip >/dev/null 2>&1; then ok "unzip"; else bad "unzip missing  → 'sudo apt install unzip'"; fi
if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then ok "curl or wget (for the one-time toolchain download)"; else bad "need curl or wget  → 'sudo apt install curl'"; fi

echo
echo "[ code-droid toolchain ]   ($DEST)"
if ls "$DEST"/sdk/build-tools/*/aapt2 >/dev/null 2>&1 && ls "$DEST"/sdk/platforms/*/android.jar >/dev/null 2>&1 && ls "$DEST"/kotlin/*/bin/kotlinc >/dev/null 2>&1; then
  ok "toolchain installed ($(du -sh "$DEST" 2>/dev/null | cut -f1))"
else
  warn "toolchain not downloaded yet  → run:  bash tools/install.sh   (~300MB, one time)"
fi

echo
echo "[ machine ]"
if command -v free >/dev/null 2>&1; then
  MEM=$(free -m | awk '/^Mem/{print $2}')
  if [ "$MEM" -ge 3000 ]; then ok "RAM: ${MEM}MB — plenty"; else warn "RAM: ${MEM}MB — code-droid targets 4GB machines; close browsers/tabs during builds"; fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "================="
  echo "✔ You're ready:  bash tools/install.sh && npm start   → http://localhost:3000"
else
  echo "================="
  echo "✖ Fix the ✖ items above, then re-run:  npm run doctor"
fi
exit $FAIL
