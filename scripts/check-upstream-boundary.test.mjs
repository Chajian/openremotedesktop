import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkInstalledPackage, checkUpstreamBoundary } from "./check-upstream-boundary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = "@wonderwhy-er/desktop-commander";
const baseline = JSON.parse(readFileSync(join(root, "scripts/upstream-desktop-commander-0.3.1.json"), "utf8"));
const launcher = "packages/desktop-commander-adapter/src/desktop-commander-client.ts";
const lock = `lockfileVersion: '9.0'\nimporters:\n  packages/desktop-commander-adapter:\n    dependencies:\n      '${upstream}':\n        specifier: 0.3.1\n        version: 0.3.1\npackages:\n  '${upstream}@0.3.1':\n    resolution: {integrity: ${baseline.integrity}}\nsnapshots:\n  '${upstream}@0.3.1': {}\n`;
function write(dir, name, content) {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "upstream-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, "package.json", JSON.stringify({ private: true, scripts: { build: "node scripts/build.mjs" } }));
  write(dir, "packages/desktop-commander-adapter/package.json", JSON.stringify({ dependencies: { [upstream]: "0.3.1" } }));
  write(dir, "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  write(dir, "pnpm-lock.yaml", lock);
  mkdirSync(dirname(join(dir, launcher)), { recursive: true });
  copyFileSync(join(root, launcher), join(dir, launcher));
  write(dir, "scripts/smoke-packaged-agent.mjs", `require.resolve("${upstream}/package.json");`);
  return dir;
}
function rejects(result, pattern) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.errors.join("\n"), pattern);
}
function check(dir) { return checkUpstreamBoundary({ root: dir, sourceOnly: true }); }
function manifest(dir, path, value) { write(dir, path, JSON.stringify(value)); }

test("source guard accepts pinned identity and the unchanged launcher", (t) => {
  assert.equal(check(fixture(t)).ok, true);
});
for (const version of ["^0.3.1", "0.2.52", "file:../fork", "npm:replacement@0.3.1", "https://example.com/commander.tgz"]) {
  test(`rejects adapter source ${version}`, (t) => {
    const dir = fixture(t);
    manifest(dir, "packages/desktop-commander-adapter/package.json", { dependencies: { [upstream]: version } });
    rejects(check(dir), /exact.*0\.3\.1/i);
  });
}
test("rejects a second workspace dependency selecting an alternative source", (t) => {
  const dir = fixture(t);
  manifest(dir, "apps/example/package.json", { optionalDependencies: { [upstream]: "git+https://example.com/fork.git" } });
  rejects(check(dir), /exact.*0\.3\.1/i);
});
test("accepts the pinned artifact with pnpm's optional Node types peer context", (t) => {
  const dir = fixture(t);
  write(dir, "pnpm-lock.yaml", lock.replace("version: 0.3.1", "version: 0.3.1(@types/node@24.19.0)"));
  assert.equal(check(dir).ok, true);
});
for (const [name, change] of [
  ["lock patched peer context", (s) => s.replace("version: 0.3.1", "version: 0.3.1(patch_hash=changed)")],
  ["lock alternative peer source", (s) => s.replace("version: 0.3.1", "version: 0.3.1(@types/node@file:../fork)")],
  ["lock different version with peer context", (s) => s.replace("version: 0.3.1", "version: 0.3.10(@types/node@24.19.0)")],
  ["lock trailing peer metadata", (s) => s.replace("version: 0.3.1", "version: 0.3.1(@types/node@24.19.0)(patch_hash=changed)")],
  ["lock specifier", (s) => s.replace("specifier: 0.3.1", "specifier: ^0.3.1")],
  ["lock version", (s) => s.replace("version: 0.3.1", "version: file:../fork")],
  ["lock integrity", (s) => s.replace(baseline.integrity, "sha512-invalid")],
  ["lock alternative tarball", (s) => s.replace("resolution: {integrity:", "resolution: {tarball: https://example.com/fork.tgz, integrity:")],
  ["lock alternative record", (s) => s.replace("packages:\n", `packages:\n  '${upstream}@file:../fork': {}\n`)],
]) {
  test(`rejects changed ${name}`, (t) => {
    const dir = fixture(t); write(dir, "pnpm-lock.yaml", change(lock));
    rejects(check(dir), /lockfile/i);
  });
}
for (const config of [
  { pnpm: { patchedDependencies: { [`${upstream}@0.3.1`]: "patches/upstream.patch" } } },
  { pnpm: { overrides: { [upstream]: "file:../fork" } } },
  { overrides: { [upstream]: "npm:replacement" } },
  { resolutions: { [upstream]: "file:../fork" } },
  { pnpm: { packageExtensions: { [`${upstream}@*`]: { dependencies: { extra: "1" } } } } },
]) {
  test(`rejects package replacement/patch config ${JSON.stringify(config)}`, (t) => {
    const dir = fixture(t); manifest(dir, "package.json", config);
    rejects(check(dir), /patch|replacement/i);
  });
}
test("rejects replacement config in pnpm workspace YAML", (t) => {
  const dir = fixture(t);
  write(dir, "pnpm-workspace.yaml", `packages:\n  - 'packages/*'\noverrides:\n  '${upstream}': file:../fork\n`);
  rejects(check(dir), /replacement/i);
});
test("rejects pnpmfile hooks instead of executing them", (t) => {
  const dir = fixture(t); write(dir, ".pnpmfile.cjs", "throw new Error('must not execute');");
  rejects(check(dir), /pnpmfile/i);
});
test("permits unrelated project lifecycle hooks without touching upstream code", (t) => {
  const dir = fixture(t); manifest(dir, "apps/example/package.json", { scripts: { postinstall: "node scripts/prepare-internal-assets.mjs" } });
  assert.equal(check(dir).ok, true);
});
test("continues rejecting scripts that explicitly rewrite upstream packages", (t) => {
  const dir = fixture(t); manifest(dir, "apps/example/package.json", { scripts: { postinstall: "node scripts/rewrite-upstream.mjs" } });
  rejects(check(dir), /rewrite/i);
});
test("rejects an obvious upstream rewrite script", (t) => {
  const dir = fixture(t);
  write(dir, "scripts/rewrite.mjs", `import { writeFileSync } from 'node:fs';\nwriteFileSync('node_modules/${upstream}/dist/index.js', 'changed');`);
  rejects(check(dir), /rewrite/i);
});
for (const code of [
  `import { run } from '${upstream}/dist/index.js';`,
  `export * from '${upstream}/dist/config.js';`,
  `const run = require('${upstream}/dist/index.js');`,
  `const run = await import('${upstream}/dist/index.js');`,
  `const run = require.resolve('${upstream}/dist/index.js');`,
  `const run = require('../node_modules/${upstream}/dist/index.js');`,
  `const run = require.resolve('${upstream}/package.json');`,
]) {
  test(`rejects deep implementation access ${code}`, (t) => {
    const dir = fixture(t); write(dir, "apps/example/src/deep.ts", code);
    rejects(check(dir), /deep.*import|package\.json.*resolution/i);
  });
}
test("package.json exception permits resolve only, not implementation import", (t) => {
  const dir = fixture(t);
  write(dir, "scripts/smoke-packaged-agent.mjs", `import upstream from '${upstream}/package.json';`);
  rejects(check(dir), /deep.*import|package\.json.*resolution/i);
});
test("permits changes to OpenRemote's own launcher without weakening upstream identity", (t) => {
  const dir = fixture(t); write(dir, launcher, readFileSync(join(dir, launcher), "utf8") + "\n// own adapter improvement\n");
  assert.equal(check(dir).ok, true);
});
test("still rejects a launcher that directly imports upstream implementation", (t) => {
  const dir = fixture(t); write(dir, launcher, readFileSync(join(dir, launcher), "utf8") + `\nimport '${upstream}/dist/index.js';\n`);
  rejects(check(dir), /deep.*import|implementation.*reference/i);
});
test("does not scan docs, test fixtures, dependencies or generated output as source", (t) => {
  const dir = fixture(t);
  for (const path of ["docs/example.md", "scripts/example.test.mjs", "apps/example/src/deep.test.ts", "node_modules/example/index.js", "apps/example/dist/index.js"]) {
    write(dir, path, `import '${upstream}/dist/index.js';`);
  }
  assert.equal(check(dir).ok, true);
});
function installed(t) {
  const dir = mkdtempSync(join(tmpdir(), "upstream-installed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { "package.json": JSON.stringify({ name: upstream, version: "0.3.1", scripts: { postinstall: "node original-postinstall.js" } }), "dist/index.js": "console.log('published');\n" };
  const reference = { ...baseline, files: {} };
  for (const [path, body] of Object.entries(files)) {
    write(dir, path, body); reference.files[path] = createHash("sha256").update(body).digest("hex");
  }
  return { dir, reference };
}
function checkInstall({ dir, reference }) { return checkInstalledPackage({ installedPackagePath: dir, baseline: reference }); }
test("installed checker accepts original published files and original lifecycle scripts", (t) => {
  assert.equal(checkInstall(installed(t)).ok, true);
});
for (const [kind, mutate] of [
  ["modified", (dir) => write(dir, "dist/index.js", "changed")],
  ["missing", (dir) => rmSync(join(dir, "dist/index.js"))],
  ["added code", (dir) => write(dir, "dist/extra.mjs", "export {};\n")],
  ["added executable", (dir) => { write(dir, "helper", "#!/bin/sh\necho changed\n"); chmodSync(join(dir, "helper"), 0o755); }],
  ["added shebang script without executable bit", (dir) => write(dir, "helper", "#!/usr/bin/env node\nconsole.log('changed')\n")],
  ["added code symlink", (dir) => symlinkSync(join(dir, "dist/index.js"), join(dir, "extra.js"))],
  ["published file symlink", (dir) => { rmSync(join(dir, "dist/index.js")); symlinkSync(join(dir, "package.json"), join(dir, "dist/index.js")); }],
]) {
  test(`installed checker rejects ${kind}`, (t) => {
    const install = installed(t); mutate(install.dir);
    rejects(checkInstall(install), /modified|missing|added|symlink/i);
  });
}
test("installed checker permits dependencies and nonexecutable runtime data", (t) => {
  const install = installed(t);
  write(install.dir, "node_modules/dependency/index.js", "// dependency, outside published package\n");
  write(install.dir, "logs/session.log", "runtime data");
  write(install.dir, "config.json", "{}");
  assert.equal(checkInstall(install).ok, true);
});
test("installed checker handles pnpm's symlink package directory", (t) => {
  const install = installed(t);
  const link = `${install.dir}-link`;
  symlinkSync(install.dir, link, "dir");
  t.after(() => rmSync(link, { force: true }));
  assert.equal(checkInstalledPackage({ installedPackagePath: link, baseline: install.reference }).ok, true);
});
test("CLI supports source-only, explicit root and actionable failure status", (t) => {
  const dir = fixture(t);
  const script = join(root, "scripts/check-upstream-boundary.mjs");
  const pass = spawnSync(process.execPath, [script, "--root", dir, "--source-only"], { encoding: "utf8" });
  assert.ifError(pass.error);
  assert.equal(pass.status, 0, pass.stderr);
  manifest(dir, "packages/desktop-commander-adapter/package.json", { dependencies: { [upstream]: "file:../fork" } });
  const fail = spawnSync(process.execPath, [script, "--root", dir, "--source-only"], { encoding: "utf8" });
  assert.ifError(fail.error);
  assert.equal(fail.status, 1); assert.match(fail.stderr, /exact.*0\.3\.1/i);
});

test("rejects quoted workspace patch keys", (t) => {
  const dir = fixture(t);
  write(dir, "pnpm-workspace.yaml", `packages:\n  - 'packages/*'\n"patchedDependencies":\n  '${upstream}@0.3.1': patches/upstream.patch\n`);
  rejects(check(dir), /patch|replacement/i);
});
for (const code of [
  `const entry = import.meta.resolve('${upstream}/dist/index.js');`,
  `const entry = customRequire('${upstream}/dist/index.js');`,
  `const entry = '${upstream}/dist/index.js'; await import(entry);`,
]) {
  test(`rejects literal implementation reference ${code}`, (t) => {
    const dir = fixture(t); write(dir, "scripts/deep.mjs", code);
    rejects(check(dir), /deep.*import|implementation.*reference/i);
  });
}

for (const path of ["dist/package.json", "runtime/nested/package.json"]) {
  test(`installed checker rejects added loader metadata ${path}`, (t) => {
    const install = installed(t);
    write(install.dir, path, JSON.stringify({ type: "commonjs" }));
    rejects(checkInstall(install), /added.*package\.json/i);
  });
}
const windowsImplementationPath = ["node_modules", "@wonderwhy-er", "desktop-commander", "dist", "index.js"].join("\\");
for (const [form, literal] of [
  ["escaped JS string", JSON.stringify(windowsImplementationPath)],
  ["raw template string", `String.raw\`${windowsImplementationPath}\``],
]) {
  test(`rejects Windows deep implementation path in ${form}`, (t) => {
    const dir = fixture(t);
    write(dir, "scripts/windows-deep.mjs", `const entry = require(${literal});`);
    rejects(check(dir), /deep.*import|implementation.*reference/i);
  });
  test(`rejects Windows upstream rewrite path in ${form}`, (t) => {
    const dir = fixture(t);
    write(dir, "scripts/windows-rewrite.mjs", `import { writeFileSync } from 'node:fs'; writeFileSync(${literal}, 'changed');`);
    rejects(check(dir), /rewrite/i);
  });
}
test("installed checker permits dependency manifests and ordinary runtime JSON", (t) => {
  const install = installed(t);
  write(install.dir, "node_modules/dependency/package.json", JSON.stringify({ type: "commonjs" }));
  write(install.dir, "runtime/session.json", JSON.stringify({ state: "ready" }));
  assert.equal(checkInstall(install).ok, true);
});

test("permits unrelated workspace dependency overrides", (t) => {
  const dir = fixture(t);
  write(dir, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\noverrides:\n  lodash: 4.17.21\n');
  assert.equal(check(dir).ok, true);
});
test("permits non-upstream lockfile patch metadata", (t) => {
  const dir = fixture(t);
  write(dir, "pnpm-lock.yaml", lock + "patchedDependencies:\n  unrelated-package@1.0.0:\n    hash: safe-metadata\n");
  assert.equal(check(dir).ok, true);
});
test("permits unrelated workspace patch tooling without weakening upstream file verification", (t) => {
  const dir = fixture(t);
  manifest(dir, "package.json", { devDependencies: { "patch-package": "8.0.0" }, scripts: { postinstall: "node scripts/prepare-app.mjs" } });
  assert.equal(check(dir).ok, true);
});
