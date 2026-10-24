import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const folder = fileURLToPath(new URL("../dist/agent-npm/", import.meta.url));
const pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
const expectedTag = process.argv[2];

function requireCondition(ok, message) {
  if (!ok) throw new Error("Agent release validation: " + message);
}

requireCondition(pkg.name === "open-desktop-remote-agent", "unexpected package name");
requireCondition(/^\d+\.\d+\.\d+$/.test(pkg.version), "version must be stable semver");
requireCondition(pkg.private !== true, "npm package cannot be private");
requireCondition(pkg.license === "Apache-2.0", "license mismatch");
requireCondition(
  pkg.repository?.url === "git+https://github.com/Chajian/openremotedesktop.git",
  "repository must match the trusted GitHub origin",
);
requireCondition(
  pkg.bin?.["open-desktop-remote-agent"] === "dist/cli.mjs",
  "missing CLI entry point",
);
if (expectedTag !== undefined) {
  requireCondition(expectedTag === "agent-v" + pkg.version,
    "tag " + expectedTag + " differs from package version " + pkg.version);
}
for (const dep of Object.values({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
  requireCondition(typeof dep === "string" && !dep.startsWith("workspace:"),
    "unpublished workspace dependency found");
}
requireCondition(
  pkg.dependencies?.["@wonderwhy-er/desktop-commander"] === "0.3.1",
  "Desktop Commander must remain the original pinned npm dependency",
);
const buildMeta = JSON.parse(await readFile(
  fileURLToPath(new URL("../dist/agent-build-meta.json", import.meta.url)), "utf8",
));
for (const input of Object.keys(buildMeta.inputs)) {
  const normalized = input.replaceAll("\\", "/");
  requireCondition(
    !/node_modules\/(?:@wonderwhy-er\/desktop-commander|remote-desktop-commander)(?:\/|$)/.test(normalized),
    "upstream implementation was bundled: " + normalized,
  );
}
const entries = (await readdir(folder)).sort();
requireCondition(JSON.stringify(entries) === JSON.stringify(["LICENSE", "dist", "package.json"]),
  "unexpected files in npm package: " + entries.join(", "));
const script = await readFile(join(folder, "dist", "cli.mjs"), "utf8");
requireCondition(script.startsWith("#!/usr/bin/env node\n"), "CLI is not executable with Node");
console.log("Verified " + pkg.name + "@" + pkg.version + " for " +
  (expectedTag ?? "dry-run") + " (no secrets or source checkout included).");
