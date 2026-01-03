#!/usr/bin/env bash
set -euo pipefail

PORT=8080
NEW_VERSION=""
KEEP_CHANGES=0

usage() {
  echo "Usage: $0 --new-version <x.y.z> [--port <port>] [--keep-changes]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --new-version)
      NEW_VERSION="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --keep-changes)
      KEEP_CHANGES=1
      shift
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$NEW_VERSION" ]]; then
  usage
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json)" ]]; then
    echo "Working tree has changes in version files. Commit/stash before running."
    exit 1
  fi
fi

TMP_DIR="$(mktemp -d)"
cp package.json "$TMP_DIR/package.json"
cp src-tauri/Cargo.toml "$TMP_DIR/Cargo.toml"
cp src-tauri/tauri.conf.json "$TMP_DIR/tauri.conf.json"

restore_files() {
  if [[ "$KEEP_CHANGES" -eq 1 ]]; then
    return
  fi
  cp "$TMP_DIR/package.json" package.json
  cp "$TMP_DIR/Cargo.toml" src-tauri/Cargo.toml
  cp "$TMP_DIR/tauri.conf.json" src-tauri/tauri.conf.json
}

trap restore_files EXIT

OLD_VERSION="$(node -p "require('./package.json').version")"
if [[ "$NEW_VERSION" == "$OLD_VERSION" ]]; then
  echo "New version must be different from current version ($OLD_VERSION)."
  exit 1
fi

node - <<NODE
const fs = require('fs')
const path = 'src-tauri/tauri.conf.json'
const config = JSON.parse(fs.readFileSync(path, 'utf8'))
config.plugins = config.plugins || {}
config.plugins.updater = config.plugins.updater || {}
config.plugins.updater.endpoints = ['http://127.0.0.1:${PORT}/latest.json']
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\\n')
NODE

echo "Building old app version ${OLD_VERSION} (local updater endpoint)..."
pnpm run tauri:build

OLD_APP_COPY=""
if [[ "$(uname -s)" == "Darwin" ]]; then
  OLD_APP_PATH="$(find src-tauri/target/release/bundle -type d -name '*.app' | head -n 1)"
  if [[ -n "$OLD_APP_PATH" ]]; then
    mkdir -p "$TMP_DIR/old-app"
    cp -R "$OLD_APP_PATH" "$TMP_DIR/old-app/"
    OLD_APP_COPY="$TMP_DIR/old-app/$(basename "$OLD_APP_PATH")"
  fi
fi

node - <<NODE
const fs = require('fs')
const pkgPath = 'package.json'
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.version = '${NEW_VERSION}'
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\\n')

const cargoPath = 'src-tauri/Cargo.toml'
const cargoToml = fs.readFileSync(cargoPath, 'utf8')
const updatedCargo = cargoToml.replace(/version = \"[^\"]*\"/, 'version = \"${NEW_VERSION}\"')
fs.writeFileSync(cargoPath, updatedCargo)

const tauriPath = 'src-tauri/tauri.conf.json'
const tauriConfig = JSON.parse(fs.readFileSync(tauriPath, 'utf8'))
tauriConfig.version = '${NEW_VERSION}'
fs.writeFileSync(tauriPath, JSON.stringify(tauriConfig, null, 2) + '\\n')
NODE

echo "Building new app version ${NEW_VERSION}..."
pnpm run tauri:build

LATEST_JSON="$(python3 - <<'PY'
import os, sys
root = os.path.join('src-tauri', 'target', 'release', 'bundle')
latest = None
for dirpath, _, filenames in os.walk(root):
    for name in filenames:
        if name == 'latest.json':
            path = os.path.join(dirpath, name)
            mtime = os.path.getmtime(path)
            if latest is None or mtime > latest[0]:
                latest = (mtime, path)
if latest is None:
    sys.exit(1)
print(latest[1])
PY
)"

if [[ -z "$LATEST_JSON" ]]; then
  echo "Could not find latest.json under src-tauri/target/release/bundle."
  exit 1
fi

BUNDLE_DIR="$(dirname "$LATEST_JSON")"

echo
echo "Local update server:"
echo "  Directory: $BUNDLE_DIR"
echo "  Endpoint:  http://127.0.0.1:${PORT}/latest.json"
if [[ -n "$OLD_APP_COPY" ]]; then
  echo "Run the old app from: $OLD_APP_COPY"
else
  echo "Run the previously installed app version: ${OLD_VERSION}"
fi
echo "Press Ctrl+C to stop the server."
echo

python3 -m http.server "$PORT" --directory "$BUNDLE_DIR"
