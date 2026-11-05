import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const installers = ["install-windows.ps1", "install-macos.sh", "install-linux.sh"];

test("version updates and release checksums include every installer", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "odr-release-installers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = ["scripts/set-agent-version.mjs", "scripts/prepare-github-release.mjs",
    "scripts/generate-posix-installers.mjs", "scripts/install-posix.template.sh",
    "apps/agent/src/version.json", "apps/server/src/dashboard/installer.ts",
    ...installers.map(name => "scripts/" + name)];
  for (const file of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  const templatePath = join(directory, "scripts/install-posix.template.sh");
  writeFileSync(templatePath, readFileSync(templatePath, "utf8") + "# release generation fixture\n");
  const version = "9.8.7";
  const update = spawnSync(process.execPath, ["scripts/set-agent-version.mjs", version], { cwd: directory, encoding: "utf8" });
  assert.equal(update.status, 0, update.stdout + update.stderr);
  for (const name of installers) {
    assert(readFileSync(join(directory, "scripts", name), "utf8").includes("open-desktop-remote-agent@" + version), name);
  }
  const check = spawnSync(process.execPath, ["scripts/generate-posix-installers.mjs", "--check"], { cwd: directory, encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  mkdirSync(join(directory, "dist/agent-npm"), { recursive: true });
  writeFileSync(join(directory, "dist/agent-npm/package.json"), JSON.stringify({ name: "open-desktop-remote-agent", version }));
  writeFileSync(join(directory, `dist/open-desktop-remote-agent-${version}.tgz`), "release fixture");
  const release = spawnSync(process.execPath, ["scripts/prepare-github-release.mjs", "agent-v" + version], { cwd: directory, encoding: "utf8" });
  assert.equal(release.status, 0, release.stdout + release.stderr);
  const assets = join(directory, "dist/github-release");
  const sums = readFileSync(join(assets, "SHA256SUMS.txt"), "utf8");
  for (const name of installers) {
    const bytes = readFileSync(join(assets, name));
    assert.deepEqual(bytes, readFileSync(join(directory, "scripts", name)), name);
    assert(sums.includes(createHash("sha256").update(bytes).digest("hex") + "  " + name));
  }
  assert(readFileSync(join(assets, "README-INSTALLATION.txt"), "utf8").includes("bash ./install-linux.sh"));
  writeFileSync(templatePath, readFileSync(templatePath, "utf8") + "# unreleased source change\n");
  const mismatch = spawnSync(process.execPath, ["scripts/prepare-github-release.mjs", "agent-v" + version], { cwd: directory, encoding: "utf8" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Generated POSIX installers are stale/);
  assert.equal(readFileSync(join(assets, "SHA256SUMS.txt"), "utf8"), sums, "stale check must precede release output deletion");
  const regenerate = spawnSync(process.execPath, ["scripts/generate-posix-installers.mjs"], { cwd: directory, encoding: "utf8" });
  assert.equal(regenerate.status, 0, regenerate.stdout + regenerate.stderr);
  writeFileSync(join(directory, "scripts/install-windows.ps1"), "open-desktop-remote-agent@0.0.0\n");
  const wrongVersion = spawnSync(process.execPath, ["scripts/prepare-github-release.mjs", "agent-v" + version], { cwd: directory, encoding: "utf8" });
  assert.notEqual(wrongVersion.status, 0);
  assert.match(wrongVersion.stderr, /install-windows.ps1 does not match npm version/);
});
