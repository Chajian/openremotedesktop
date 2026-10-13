import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tag = process.argv[2];
const match = /^agent-v(\d+\.\d+\.\d+)$/.exec(tag ?? "");
if (!match) throw new Error("Usage: node scripts/prepare-github-release.mjs agent-v1.2.3");
const version = match[1];
const pkg = JSON.parse(await readFile(join(root, "dist/agent-npm/package.json"), "utf8"));
if (pkg.name !== "open-desktop-remote-agent" || pkg.version !== version) {
  throw new Error("Git tag does not match the built npm Agent package");
}

const assetDir = join(root, "dist/github-release");
await rm(assetDir, { recursive: true, force: true });
await mkdir(assetDir, { recursive: true });
const files = [
  ["dist/open-desktop-remote-agent-" + version + ".tgz", "open-desktop-remote-agent-" + version + ".tgz"],
  ["scripts/install-windows.ps1", "install-windows.ps1"],
  ["scripts/install-macos.sh", "install-macos.sh"],
];
for (const [relative, filename] of files) {
  const source = join(root, relative);
  const meta = await stat(source);
  if (!meta.isFile() || meta.size === 0) throw new Error("Release asset is empty: " + relative);
  if (filename.startsWith("install-")) {
    const installer = await readFile(source, "utf8");
    if (!installer.includes("open-desktop-remote-agent@" + version)) {
      throw new Error("Installer " + filename + " does not match npm version " + version);
    }
  }
  await copyFile(source, join(assetDir, filename));
}

const instructions = [
  "Open Desktop Remote Agent " + version,
  "",
  "Release assets:",
  "- open-desktop-remote-agent-" + version + ".tgz: npm package for all supported OSes.",
  "- install-windows.ps1: Windows user-level bootstrap script.",
  "- install-macos.sh: macOS user-level bootstrap script.",
  "- SHA256SUMS.txt: checksums for the files in this release.",
  "",
  "The installers download Node.js 24 and install the exact Agent version from npm.",
  "The Node.js runtime and npm dependency tree are NOT inside the tarball.",
  "The npm version may require separate human 2FA approval before it is installable.",
  "",
  "After npm approval:",
  "Windows PowerShell: .\\install-windows.ps1 -Server https://your-server.example",
  "macOS Terminal: bash ./install-macos.sh --server https://your-server.example",
  "",
  "Inspect scripts before running them. Approve each device on your own server.",
  "The Agent runs with your account's file/terminal permissions.",
  "Keep the Agent terminal open to maintain the connection.",
  "",
  "Repository: https://github.com/Chajian/openremotedesktop",
  "npm package: https://www.npmjs.com/package/open-desktop-remote-agent",
  "",
].join("\n");
await writeFile(join(assetDir, "README-INSTALLATION.txt"), instructions);
const allAssets = [...files.map((pair) => pair[1]), "README-INSTALLATION.txt"].sort();
const sums = [];
for (const filename of allAssets) {
  const bytes = await readFile(join(assetDir, filename));
  const hex = createHash("sha256").update(bytes).digest("hex");
  sums.push(hex + "  " + filename);
}
await writeFile(join(assetDir, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log("Prepared GitHub Release assets for " + tag + " in " + assetDir);
