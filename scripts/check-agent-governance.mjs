import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Static repository/document guard. Not a substitute for model or runtime acceptance.
const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];
const read = (file) => {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) {
    failures.push(`Missing required file: ${file}`);
    return "";
  }
  return readFileSync(absolute, "utf8");
};
const requireText = (content, fragment, file) => {
  if (!content.includes(fragment)) failures.push(`${file}: expected ${fragment}`);
};

const rules = read("AGENTS.md");
const bridge = read("CLAUDE.md");
const guide = read("docs/ai-project-management.zh-CN.md");
const issue = read(".github/ISSUE_TEMPLATE/ai-task.md");
const pull = read(".github/pull_request_template.md");
const readme = read("README.md");
const ci = read(".github/workflows/ci.yml");
const pkgText = read("package.json");

if (bridge.trim() !== "@AGENTS.md") {
  failures.push("CLAUDE.md must consist of only @AGENTS.md");
}
for (const text of ["OpenRemoteDesktop", "NOT TokenHub", "apps/server/", "apps/agent/",
  "packages/protocol/", "EXECUTION_UNKNOWN", "docs/ai-project-management.zh-CN.md"]) {
  requireText(rules, text, "AGENTS.md");
}
for (const text of ["GitHub", "Worktree", "READY", "pnpm governance:check", "未验证"]) {
  requireText(guide, text, "docs/ai-project-management.zh-CN.md");
}
for (const text of ["name: AI engineering task", "## Goal", "## Acceptance criteria",
  "## Validation plan", "## Cross-agent handoff"]) {
  requireText(issue, text, ".github/ISSUE_TEMPLATE/ai-task.md");
}
for (const text of ["## Purpose", "## Verification", "## Risks", "## Handoff"]) {
  requireText(pull, text, ".github/pull_request_template.md");
}
for (const text of ["AGENTS.md", "docs/ai-project-management.zh-CN.md"]) {
  requireText(readme, text, "README.md");
}
let pkg;
try { pkg = JSON.parse(pkgText); } catch { failures.push("package.json is not valid JSON"); }
if (pkg?.scripts?.["governance:check"] !== "node scripts/check-agent-governance.mjs") {
  failures.push("package.json: governance:check script is missing or changed");
}
requireText(ci, "pnpm governance:check", ".github/workflows/ci.yml");

for (const [file, content] of [
  ["AGENTS.md", rules], ["docs/ai-project-management.zh-CN.md", guide],
  [".github/ISSUE_TEMPLATE/ai-task.md", issue], [".github/pull_request_template.md", pull],
]) {
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const destination = match[1].split("#")[0].trim();
    if (!destination || /^(?:https?:|mailto:|\/\/)/i.test(destination)) continue;
    const target = resolve(root, dirname(file), decodeURIComponent(destination));
    if (!existsSync(target)) failures.push(`${file}: broken relative link ${destination}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`AI governance check: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("AI governance check passed: canonical instructions, task templates, CI hook and relative links.");
}
