#!/usr/bin/env bash
# Open Desktop Remote Agent installer (user-level; no Homebrew required).
set -euo pipefail
SERVER=''
PACKAGE_SOURCE='open-desktop-remote-agent@0.1.1'
INSTALL_DIR="$HOME/Library/Application Support/OpenDesktopRemote"
INSTALL_ONLY=0

while (($#)); do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --package) PACKAGE_SOURCE="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --install-only) INSTALL_ONLY=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ! "$SERVER" =~ ^https://([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(:[0-9]+)?/?$ ]]; then
  echo 'Pass a valid HTTPS server origin using --server.' >&2
  exit 2
fi
SERVER="${SERVER%/}"
case "$(uname -m)" in
  arm64) arch='arm64' ;;
  x86_64) arch='x64' ;;
  *) echo 'Unsupported macOS CPU architecture.' >&2; exit 2 ;;
esac
mkdir -p "$INSTALL_DIR"
runtime="$INSTALL_DIR/runtime"
node="$runtime/bin/node"
version=''
if [[ -x "$node" ]]; then version="$("$node" --version)"; fi
if [[ ! "$version" =~ ^v24\. ]]; then
  base='https://nodejs.org/dist/latest-v24.x'
  echo 'Downloading Node.js 24 from nodejs.org...'
  sums="$(curl --fail --silent --show-error --location "$base/SHASUMS256.txt")"
  line="$(printf '%s\n' "$sums" | grep -E "^[a-fA-F0-9]{64}[[:space:]]+node-v24\.[0-9]+\.[0-9]+-darwin-$arch\.tar\.gz$" | head -n 1)"
  [[ -n "$line" ]] || { echo 'Node.js archive checksum not found.' >&2; exit 1; }
  expected="$(printf '%s' "$line" | cut -c1-64)"
  archive_name="$(printf '%s' "$line" | awk '{print $2}')"
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  curl --fail --silent --show-error --location "$base/$archive_name" -o "$scratch/$archive_name"
  (cd "$scratch" && printf '%s  %s\n' "$expected" "$archive_name" | shasum -a 256 -c -)
  tar -xzf "$scratch/$archive_name" -C "$scratch"
  [[ ! -d "$runtime" ]] || rm -rf "$runtime"
  mv "$scratch/${archive_name%.tar.gz}" "$runtime"
fi
npm="$runtime/lib/node_modules/npm/bin/npm-cli.js"
[[ -f "$npm" ]] || { echo 'npm missing from Node.js distribution.' >&2; exit 1; }
cli="$INSTALL_DIR/node_modules/open-desktop-remote-agent/dist/cli.mjs"
manifest="$INSTALL_DIR/node_modules/open-desktop-remote-agent/package.json"
expected=''
if [[ "$PACKAGE_SOURCE" =~ ^open-desktop-remote-agent@([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  expected="${BASH_REMATCH[1]}"
fi
current=''
if [[ -f "$manifest" ]]; then
  current="$("$node" -p "require(process.argv[1]).version" "$manifest")"
fi
if [[ -n "$expected" && "$current" == "$expected" && -f "$cli" ]]; then
  echo "Agent $expected is already installed; keeping existing device identity."
else
  echo 'Installing Agent from official npm Registry...'
  "$node" "$npm" install --registry=https://registry.npmjs.org/ --prefix "$INSTALL_DIR" --no-audit --no-fund --package-lock=false "$PACKAGE_SOURCE" || {
    echo 'npm installation failed. Check network access to registry.npmjs.org.' >&2; exit 1;
  }
fi
[[ -f "$cli" ]] || { echo 'Agent CLI was not installed.' >&2; exit 1; }
echo "Agent installed in $INSTALL_DIR"
if [[ "$INSTALL_ONLY" -eq 1 ]]; then exit 0; fi
echo "Approve your computer at $SERVER/device when the pairing code appears."
echo 'Keep this Terminal window open while you want this computer online.'
exec "$node" "$cli" agent connect --server "$SERVER"
