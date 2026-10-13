import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/set-agent-version.mjs 0.1.1");
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entries = [
  ["scripts/build-agent-package.mjs", /version: "\d+\.\d+\.\d+",/, `version: "${version}",`],
  ["scripts/install-windows.ps1", /open-desktop-remote-agent@\d+\.\d+\.\d+/, `open-desktop-remote-agent@${version}`],
  ["scripts/install-macos.sh", /open-desktop-remote-agent@\d+\.\d+\.\d+/, `open-desktop-remote-agent@${version}`],
  ["apps/server/src/dashboard/installer.ts", /AGENT_INSTALL_VERSION = "\d+\.\d+\.\d+"/, `AGENT_INSTALL_VERSION = "${version}"`],
];
const patches = [];
for (const [file, pattern, replacement] of entries) {
  const path = join(root, file);
  const before = await readFile(path, "utf8");
  const match = before.match(pattern);
  if (!match || [...before.matchAll(new RegExp(pattern.source, "g"))].length !== 1) {
    throw new Error("Expected exactly one version reference in " + file);
  }
  patches.push({ path, after: before.replace(pattern, replacement) });
}
for (const patch of patches) await writeFile(patch.path, patch.after);
console.log("Agent npm version and both installers now target " + version);
