import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DESKTOP_COMMANDER_VERSION } from "@open-desktop-remote/desktop-commander-adapter";
import agentRelease from "./version.json" with { type: "json" };

const root = fileURLToPath(new URL("../../../", import.meta.url));
const releasePath = "apps/agent/src/version.json";
const targets = [
  "scripts/set-agent-version.mjs",
  "scripts/build-agent-package.mjs",
  "scripts/install-windows.ps1",
  "scripts/install-macos.sh",
  "apps/server/src/dashboard/installer.ts",
];

it("builds the same Agent and upstream versions advertised by the installers and runtime", () => {
  const build = spawnSync(process.execPath, [join(root, "scripts/build-agent-package.mjs")], {
    cwd: root, encoding: "utf8", timeout: 20_000,
  });
  expect(build.status, build.stderr).toBe(0);
  const pkg = JSON.parse(readFileSync(join(root, "dist/agent-npm/package.json"), "utf8"));
  const adapter = JSON.parse(readFileSync(
    join(root, "packages/desktop-commander-adapter/package.json"), "utf8",
  ));
  expect(pkg.version).toBe(agentRelease.version);
  expect(pkg.dependencies["@wonderwhy-er/desktop-commander"])
    .toBe(adapter.dependencies["@wonderwhy-er/desktop-commander"]);
  expect(pkg.dependencies["@wonderwhy-er/desktop-commander"])
    .toBe(DESKTOP_COMMANDER_VERSION);
  for (const relative of ["scripts/install-windows.ps1", "scripts/install-macos.sh"]) {
    const installer = readFileSync(join(root, relative), "utf8");
    expect(installer.match(/open-desktop-remote-agent@(\d+\.\d+\.\d+)/)?.[1])
      .toBe(pkg.version);
  }
  const dashboard = readFileSync(join(root, "apps/server/src/dashboard/installer.ts"), "utf8");
  expect(dashboard.match(/AGENT_INSTALL_VERSION = "([^"]+)"/)?.[1]).toBe(pkg.version);
  const verify = spawnSync(process.execPath, [
    join(root, "scripts/verify-agent-release.mjs"), `agent-v${pkg.version}`,
  ], { cwd: root, encoding: "utf8", timeout: 20_000 });
  expect(verify.status, verify.stderr).toBe(0);
}, 30_000);

it("bumps the Agent release metadata and installer targets together", () => {
  const fixture = mkdtempSync(join(tmpdir(), "odr-agent-version-"));
  try {
    for (const relative of targets) {
      const destination = join(fixture, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, relative), destination);
    }
    mkdirSync(dirname(join(fixture, releasePath)), { recursive: true });
    writeFileSync(join(fixture, releasePath), '{\n  "version": "0.1.2"\n}\n');
    const result = spawnSync(
      process.execPath,
      [join(fixture, "scripts/set-agent-version.mjs"), "9.8.7"],
      { cwd: fixture, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(fixture, releasePath), "utf8"))).toEqual({
      version: "9.8.7",
    });
    for (const relative of ["scripts/install-windows.ps1", "scripts/install-macos.sh"]) {
      expect(readFileSync(join(fixture, relative), "utf8"))
        .toContain("open-desktop-remote-agent@9.8.7");
    }
    expect(readFileSync(join(fixture, "apps/server/src/dashboard/installer.ts"), "utf8"))
      .toContain('AGENT_INSTALL_VERSION = "9.8.7"');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
