import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const releasePath = "apps/agent/src/version.json";
const targets = [
  "scripts/set-agent-version.mjs",
  "scripts/build-agent-package.mjs",
  "scripts/install-windows.ps1",
  "scripts/install-macos.sh",
  "apps/server/src/dashboard/installer.ts",
];

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
