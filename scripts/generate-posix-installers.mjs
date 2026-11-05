import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platforms = {
  macos: {
    DESCRIPTION: "Open Desktop Remote Agent installer (user-level; no Homebrew required).",
    NODE_PLATFORM: "darwin",
    CHECKSUM_COMMAND: "shasum -a 256",
  },
  linux: {
    DESCRIPTION: "Open Desktop Remote Agent installer for glibc Linux (user-level; no sudo required).",
    NODE_PLATFORM: "linux",
    CHECKSUM_COMMAND: "sha256sum",
  },
};

// Generation happens only in the repository. Distributed installers contain all
// required logic and never source or download this template at runtime.
export async function generatePosixInstallers(root, { check = false } = {}) {
  const { version } = JSON.parse(await readFile(join(root, "apps/agent/src/version.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Agent release version");
  const template = await readFile(join(root, "scripts/install-posix.template.sh"), "utf8");
  const outputs = Object.entries(platforms).map(([platform, values]) => {
    const tokens = { ...values, AGENT_VERSION: version };
    const contents = template
      .replace(/^# @if (macos|linux)\n([\s\S]*?)^# @endif\n/gm, (_, target, body) => target === platform ? body : "")
      .replace(/@@([A-Z_]+)@@/g, (_, key) => {
        if (!(key in tokens)) throw new Error("Unknown POSIX installer template token: " + key);
        return tokens[key];
      });
    if (/^# @(if|endif)\b/m.test(contents)) throw new Error("Invalid POSIX installer template conditional");
    return { file: `scripts/install-${platform}.sh`, contents };
  });
  if (check) {
    const stale = [];
    for (const { file, contents } of outputs) {
      const actual = await readFile(join(root, file)).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (!actual?.equals(Buffer.from(contents))) stale.push(file);
    }
    if (stale.length) {
      throw new Error("Generated POSIX installers are stale: " + stale.join(", ") +
        ". Run node scripts/generate-posix-installers.mjs");
    }
  } else {
    for (const { file, contents } of outputs) await writeFile(join(root, file), contents);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== "--check")) {
    throw new Error("Usage: node scripts/generate-posix-installers.mjs [--check]");
  }
  await generatePosixInstallers(dirname(dirname(fileURLToPath(import.meta.url))), {
    check: process.argv.includes("--check"),
  });
}
