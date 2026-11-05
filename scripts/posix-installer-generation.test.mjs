import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const generated = ["scripts/install-macos.sh", "scripts/install-linux.sh"];
const source = "scripts/install-posix.template.sh";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "odr-posix-generation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of ["scripts/generate-posix-installers.mjs", source, "apps/agent/src/version.json", ...generated]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  return directory;
}

function run(directory, ...args) {
  return spawnSync(process.execPath, ["scripts/generate-posix-installers.mjs", ...args], {
    cwd: directory, encoding: "utf8", timeout: 10_000,
  });
}

test("committed standalone POSIX installers match their source", () => {
  const result = run(root, "--check");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("repeated generation is byte-for-byte deterministic", (t) => {
  const directory = fixture(t);
  const before = generated.map(file => readFileSync(join(directory, file)));
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = run(directory);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    generated.forEach((file, index) => assert.deepEqual(readFileSync(join(directory, file)), before[index]));
  }
});

test("source drift fails check without rewriting artifacts and generation repairs both", (t) => {
  const directory = fixture(t);
  const before = generated.map(file => readFileSync(join(directory, file)));
  writeFileSync(join(directory, source), readFileSync(join(directory, source), "utf8") + "# shared change\n");
  const stale = run(directory, "--check");
  assert.notEqual(stale.status, 0);
  for (const file of generated) assert(stale.stderr.includes(file), stale.stderr);
  generated.forEach((file, index) => assert.deepEqual(readFileSync(join(directory, file)), before[index]));
  const repair = run(directory);
  assert.equal(repair.status, 0, repair.stdout + repair.stderr);
  for (const file of generated) assert(readFileSync(join(directory, file), "utf8").endsWith("# shared change\n"));
  assert.equal(run(directory, "--check").status, 0);
});
