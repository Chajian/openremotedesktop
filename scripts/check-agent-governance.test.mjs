import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { inspectProject } from "./check-agent-governance.mjs";

const valid = {
  "AGENTS.md": "# Rules\n\n[Architecture](docs/architecture.md)\n",
  "CLAUDE.md": "@AGENTS.md\n",
  "README.md": "# A project\n\n[Workflow](docs/ai-project-management.zh-CN.md)\n",
  "package.json": JSON.stringify({ scripts: { "governance:check": "node scripts/check-agent-governance.mjs" } }),
  "docs/architecture.md": "# Architecture\n",
  "docs/ai-project-management.zh-CN.md": "# Workflow\n",
  ".github/ISSUE_TEMPLATE/ai-task.md": "---\nname: AI task\nabout: Optional task tracking\n---\n\n## Task\n",
  ".github/pull_request_template.md": "# PR\n",
  ".github/workflows/ci.yml": "steps:\n  - name: Structure check\n    run: pnpm governance:check\n",
};

function fixture(t, changes = {}) {
  const folder = mkdtempSync(join(tmpdir(), "odr-governance-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const merged = { ...valid, ...changes };
  for (const [path, value] of Object.entries(merged)) {
    if (value === null) continue;
    const full = join(folder, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, value, "utf8");
  }
  return folder;
}

test("valid structural fixtures are not coupled to project prose", (t) => {
  const folder = fixture(t, { "AGENTS.md": "# Different project instructions\n" });
  assert.deepEqual(inspectProject(folder), []);
});

test("canonical Claude bridge cannot duplicate or override instructions", (t) => {
  const folder = fixture(t, { "CLAUDE.md": "@AGENTS.md\nAdditional rules\n" });
  assert.match(inspectProject(folder).join("\n"), /CLAUDE\.md must only import/);
});

test("missing required files fail instead of reporting success", (t) => {
  const folder = fixture(t, { "docs/architecture.md": null });
  assert.match(inspectProject(folder).join("\n"), /Missing file: docs\/architecture\.md/);
});

test("broken relative links fail but fenced markdown examples do not", (t) => {
  const folder = fixture(t, {
    "AGENTS.md": "# Rules\n\n[missing](docs/missing.md)\n\n```md\n[example](not-a-real-file)\n```\n",
  });
  const errors = inspectProject(folder).join("\n");
  assert.match(errors, /broken link: docs\/missing\.md/);
  assert.doesNotMatch(errors, /not-a-real-file/);
});

test("relative links may not escape a project root", (t) => {
  const folder = fixture(t, { "AGENTS.md": "[unsafe](../../outside.md)\n" });
  assert.match(inspectProject(folder).join("\n"), /link escapes repository/);
});

test("GitHub Issue metadata is checked without enforcing Issue use", (t) => {
  const folder = fixture(t, { ".github/ISSUE_TEMPLATE/ai-task.md": "## Task with no frontmatter\n" });
  assert.match(inspectProject(folder).join("\n"), /name\/about frontmatter/);
});

test("CI must invoke the governance command", (t) => {
  const folder = fixture(t, { ".github/workflows/ci.yml": "steps:\n  - run: echo something\n" });
  assert.match(inspectProject(folder).join("\n"), /CI must invoke/);
});

test("invalid package manifests fail", (t) => {
  const folder = fixture(t, { "package.json": "{ invalid" });
  assert.match(inspectProject(folder).join("\n"), /not valid JSON/);
});
