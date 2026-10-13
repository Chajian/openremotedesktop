import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/agent/package.json", import.meta.url));
const { build } = require("esbuild");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist", "agent-npm");
const entry = join(output, "dist", "cli.mjs");
await rm(output, { recursive: true, force: true });
await mkdir(dirname(entry), { recursive: true });

// Bundle our private workspace packages; leave published/npm-native libraries external.
await build({
  entryPoints: [join(root, "apps", "agent", "src", "main.ts")],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@modelcontextprotocol/client",
    "@wonderwhy-er/desktop-commander",
    "@napi-rs/keyring",
    "ws",
    "zod",
  ],
});
await chmod(entry, 0o755);

const manifest = {
  name: "open-desktop-remote-agent",
  version: "0.1.1",
  description: "Workstation agent for the self-hosted Open Desktop Remote relay",
  license: "Apache-2.0",
  type: "module",
  bin: { "open-desktop-remote-agent": "dist/cli.mjs" },
  engines: { node: ">=24" },
  files: ["dist/"],
  repository: {
    type: "git",
    url: "git+https://github.com/Chajian/openremotedesktop.git",
  },
  dependencies: {
    "@modelcontextprotocol/client": "2.2.0",
    "@wonderwhy-er/desktop-commander": "0.2.52",
    ws: "^8.18.3",
    zod: "^4.0.0",
  },
  optionalDependencies: { "@napi-rs/keyring": "2.1.0" },
};
await writeFile(join(output, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
console.log("Prepared npm package in " + output + " (not published).");
