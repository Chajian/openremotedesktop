#!/usr/bin/env bash
# Open Desktop Remote Agent installer (user-level; no Homebrew required).
set -euo pipefail
SERVER=''
PACKAGE_SOURCE='open-desktop-remote-agent@0.1.5'
DOWNLOAD_SOURCE='official'
INSTALL_DIR="$HOME/Library/Application Support/OpenDesktopRemote"
INSTALL_ONLY=0

while (($#)); do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --package) PACKAGE_SOURCE="$2"; shift 2 ;;
    --download-source) DOWNLOAD_SOURCE="${2:-}"; [[ $# -ge 2 ]] || { echo 'Missing download source.' >&2; exit 2; }; shift 2 ;;
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
case "$DOWNLOAD_SOURCE" in
  official|npmmirror) ;;
  *) echo 'Download source must be official or npmmirror.' >&2; exit 2 ;;
esac
if [[ "$DOWNLOAD_SOURCE" == npmmirror && ! "$PACKAGE_SOURCE" =~ ^open-desktop-remote-agent@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'npmmirror requires an exact npm Agent version.' >&2; exit 2
fi
scratch=''
package_scratch=''
trap '[[ -z "$scratch" ]] || rm -rf "$scratch"; [[ -z "$package_scratch" ]] || rm -rf "$package_scratch"' EXIT
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
  sums="$(curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 "$base/SHASUMS256.txt")"
  line="$(printf '%s\n' "$sums" | grep -E "^[a-fA-F0-9]{64}[[:space:]]+node-v24\.[0-9]+\.[0-9]+-darwin-$arch\.tar\.gz$" | head -n 1)"
  [[ -n "$line" ]] || { echo 'Node.js archive checksum not found.' >&2; exit 1; }
  expected="$(printf '%s' "$line" | cut -c1-64)"
  archive_name="$(printf '%s' "$line" | awk '{print $2}')"
  scratch="$(mktemp -d)"
  if [[ "$DOWNLOAD_SOURCE" == npmmirror ]]; then
    node_version="${archive_name#node-}"
    node_version="${node_version%%-darwin-*}"
    if ! curl --fail --silent --show-error --location --connect-timeout 15 --max-time 120 "https://npmmirror.com/mirrors/node/$node_version/$archive_name" -o "$scratch/$archive_name"; then
      echo 'Mirror download unavailable; downloading Node.js from nodejs.org.'
      curl --fail --silent --show-error --location --connect-timeout 15 --max-time 120 "$base/$archive_name" -o "$scratch/$archive_name"
    fi
  else
    curl --fail --silent --show-error --location --connect-timeout 15 --max-time 120 "$base/$archive_name" -o "$scratch/$archive_name"
  fi
  (cd "$scratch" && printf '%s  %s\n' "$expected" "$archive_name" | shasum -a 256 -c -)
  tar -xzf "$scratch/$archive_name" -C "$scratch"
  [[ ! -d "$runtime" ]] || rm -rf "$runtime"
  mv "$scratch/${archive_name%.tar.gz}" "$runtime"
fi
npm="$runtime/lib/node_modules/npm/bin/npm-cli.js"
[[ -f "$npm" ]] || { echo 'npm missing from Node.js distribution.' >&2; exit 1; }
# npm lifecycle scripts and Agent children must find the private Node runtime.
export PATH="$runtime/bin:$PATH"
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
  registry='https://registry.npmjs.org/'
  install_source="$PACKAGE_SOURCE"
  if [[ "$DOWNLOAD_SOURCE" == npmmirror ]]; then
    package_scratch="$(mktemp -d)"
    curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 "https://registry.npmjs.org/open-desktop-remote-agent/$expected" -o "$package_scratch/metadata.json"
    official_tarball="https://registry.npmjs.org/open-desktop-remote-agent/-/open-desktop-remote-agent-$expected.tgz"
    "$node" -e '
      const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (m.name !== "open-desktop-remote-agent" || m.version !== process.argv[2] ||
          m.dist?.tarball !== process.argv[3] || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(m.dist?.integrity)) {
        throw new Error("Official Agent metadata is invalid or lacks SHA512 integrity.");
      }
    ' "$package_scratch/metadata.json" "$expected" "$official_tarball"
    install_source="$package_scratch/agent.tgz"
    registry='https://registry.npmmirror.com/'
    if ! curl --fail --silent --show-error --location --connect-timeout 15 --max-time 120 "https://registry.npmmirror.com/open-desktop-remote-agent/-/open-desktop-remote-agent-$expected.tgz" -o "$install_source"; then
      echo 'Mirror download unavailable; downloading Agent from official npm Registry.'
      registry='https://registry.npmjs.org/'
      curl --fail --silent --show-error --location --connect-timeout 15 --max-time 120 "$official_tarball" -o "$install_source"
    fi
    "$node" -e '
      const fs = require("node:fs"), crypto = require("node:crypto");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const actual = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(process.argv[2])).digest("base64");
      if (actual !== m.dist.integrity) throw new Error("Agent archive integrity mismatch.");
    ' "$package_scratch/metadata.json" "$install_source"
  fi
  echo "Installing Agent using $registry"
  # Never retry npm: a failed install may already have run lifecycle scripts.
  "$node" "$npm" install "--registry=$registry" --prefix "$INSTALL_DIR" --no-audit --no-fund --package-lock=false "$install_source" || {
    echo 'npm installation failed. Check network access; installation was not retried.' >&2; exit 1;
  }
fi
[[ -f "$cli" ]] || { echo 'Agent CLI was not installed.' >&2; exit 1; }
echo "Agent installed in $INSTALL_DIR"
if [[ "$INSTALL_ONLY" -eq 1 ]]; then exit 0; fi
[[ -z "$scratch" ]] || rm -rf "$scratch"
[[ -z "$package_scratch" ]] || rm -rf "$package_scratch"
echo "Approve your computer at $SERVER/device when the pairing code appears."
echo 'Keep this Terminal window open while you want this computer online.'
exec "$node" "$cli" agent connect --server "$SERVER"
