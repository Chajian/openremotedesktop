import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const nodeDirectory = dirname(process.execPath);
const npmDirectory = [
  join(nodeDirectory, "node_modules/npm"),
  resolve(nodeDirectory, "../lib/node_modules/npm"),
  resolve(nodeDirectory, "../share/nodejs/npm"),
].find((path) => existsSync(join(path, "bin/npm-cli.js")));

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options });
}

function fixture(t) {
  assert(npmDirectory, "Run with a Node.js distribution that includes npm");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "odr-installer-path-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const install = join(directory, "installation with spaces");
  const runtime = join(install, "runtime");
  const bin = windows ? runtime : join(runtime, "bin");
  const npm = windows ? join(runtime, "node_modules/npm") : join(runtime, "lib/node_modules/npm");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, join(bin, windows ? "node.exe" : "node"));
  cpSync(npmDirectory, npm, { recursive: true });
  const packageDirectory = join(directory, "package");
  mkdirSync(join(packageDirectory, "dist"), { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
    name: "open-desktop-remote-agent", version: "0.0.0",
    scripts: { postinstall: "node postinstall.cjs" },
  }));
  writeFileSync(join(packageDirectory, "postinstall.cjs"), `
    require('node:fs').writeFileSync(process.env.ODR_TEST_INSTALL_EVIDENCE, process.execPath);
    if (process.env.ODR_TEST_INSTALL_FAIL === '1') process.exit(17);
  `);
  writeFileSync(join(packageDirectory, "dist/cli.mjs"), `
    import { spawnSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.ODR_TEST_ARGUMENT_EVIDENCE, JSON.stringify(process.argv.slice(2)));
    const child = spawnSync('node', ['-e', "require('node:fs').writeFileSync(process.env.ODR_TEST_CONNECT_EVIDENCE, process.execPath)"], { stdio: 'inherit' });
    process.exit(child.status === 0 && process.env.ODR_TEST_AGENT_FAIL === '1' ? 19 : (child.status ?? 1));
  `);
  const packed = run(process.execPath, [join(npmDirectory, "bin/npm-cli.js"), "pack", "--offline", "--ignore-scripts", "--pack-destination", directory], { cwd: packageDirectory });
  assert.equal(packed.status, 0, packed.stderr);
  const archive = join(directory, "open-desktop-remote-agent-0.0.0.tgz");
  // Only these system tools are needed when the private runtime is already present.
  // Do not include /usr/bin: hosted runners can have a global Node there.
  const systemTools = join(directory, "system-tools");
  mkdirSync(systemTools);
  if (!windows) {
    for (const name of ["uname", "mkdir", "sh"]) {
      const command = run("/bin/sh", ["-c", `command -v ${name}`]);
      assert.equal(command.status, 0);
      symlinkSync(command.stdout.trim(), join(systemTools, name));
    }
  }
  return { directory, install, bin, archive, systemTools, packageDirectory };
}

for (const mode of ["install-only", "connect", "npm-failure", ...(windows ? ["support", "support-failure"] : [])]) {
  test(`installer supplies private Node to child processes (${mode})`, (t) => {
    const f = fixture(t);
    const support = mode.startsWith("support");
    const invite = "test-invite-" + "0".repeat(20);
    if (support) {
      // The support guard requires an exact npm version. Seed a matching install
      // so the real installer takes its reuse path without contacting a registry.
      const installed = join(f.install, "node_modules/open-desktop-remote-agent");
      cpSync(f.packageDirectory, installed, { recursive: true });
      writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "open-desktop-remote-agent", version: "0.1.4" }));
    }
    const installEvidence = join(f.directory, "postinstall-node.txt");
    const connectEvidence = join(f.directory, "connect-node.txt");
    const argumentEvidence = join(f.directory, "arguments.json");
    const env = { ...process.env, npm_config_offline: "true", ODR_TEST_INSTALL_EVIDENCE: installEvidence,
      ODR_TEST_ARGUMENT_EVIDENCE: argumentEvidence, ODR_TEST_AGENT_FAIL: mode === "support-failure" ? "1" : "0",
      ODR_TEST_CONNECT_EVIDENCE: connectEvidence, ODR_TEST_INSTALL_FAIL: mode === "npm-failure" ? "1" : "0" };
    let result;
    if (windows) {
      const wrapper = join(f.directory, "invoke.ps1");
      writeFileSync(wrapper, `
        param([string]$Installer, [string]$Destination, [string]$Archive, [string]$Mode)
        $ErrorActionPreference = 'Stop'
        $env:PATH = "$env:SystemRoot\\System32;$env:SystemRoot"
        $odrTestOriginalPath = $env:PATH
        if (Get-Command node -ErrorAction SilentlyContinue) { throw 'Fixture unexpectedly has global Node' }
        $odrTestFailure = $null
        try {
          if ($Mode.StartsWith('support')) {
            . $Installer -Server https://remote.example.test -InstallDir $Destination -PackageSource open-desktop-remote-agent@0.1.4 -SupportInvite '${invite}'
          } else {
            . $Installer -Server https://remote.example.test -InstallDir $Destination -PackageSource $Archive -InstallOnly:($Mode -ne 'connect')
          }
        } catch { $odrTestFailure = $_ }
        if ($env:PATH -cne $odrTestOriginalPath) { throw 'Installer changed caller PATH' }
        if ($Mode -eq 'npm-failure') {
          if (-not $odrTestFailure -or $odrTestFailure.ToString() -notmatch 'npm installation failed') { throw 'Expected npm failure' }
        } elseif ($Mode -eq 'support-failure') {
          if (-not $odrTestFailure -or $odrTestFailure.ToString() -notmatch 'Agent stopped unexpectedly') { throw 'Expected Agent failure' }
        } elseif ($odrTestFailure) { throw $odrTestFailure }
        exit 0
      `);
      result = run("pwsh", ["-NoProfile", "-File", wrapper, "-Installer", join(root, "scripts/install-windows.ps1"),
        "-Destination", f.install, "-Archive", f.archive, "-Mode", mode], { env });
    } else {
      env.PATH = f.systemTools;
      result = run("/bin/bash", [join(root, "scripts/install-macos.sh"), "--server", "https://remote.example.test",
        "--install-dir", f.install, "--package", f.archive, ...(mode === "connect" ? [] : ["--install-only"])], { env });
    }
    const expectedStatus = !windows && mode === "npm-failure" ? 1 : 0;
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    // Reaching the real npm postinstall proves PATH lookup worked even on failure.
    if (support) {
      assert.equal(existsSync(installEvidence), false, "Matching support package should be reused");
    } else {
      assert.equal(readFileSync(installEvidence, "utf8"), join(f.bin, windows ? "node.exe" : "node"));
    }
    if (mode === "connect" || support) {
      assert.equal(readFileSync(connectEvidence, "utf8"), join(f.bin, windows ? "node.exe" : "node"));
      assert.deepEqual(JSON.parse(readFileSync(argumentEvidence, "utf8")), [
        "agent", support ? "support" : "connect", "--server", "https://remote.example.test",
        ...(support ? ["--invite", invite] : []),
      ]);
    }
  });
}
