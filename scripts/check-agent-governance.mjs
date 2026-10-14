import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Checks repository structure, never model compliance or production behavior.
const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const required = [
  "AGENTS.md", "CLAUDE.md", "README.md", "package.json",
  "docs/architecture.md", "docs/ai-project-management.zh-CN.md",
  ".github/ISSUE_TEMPLATE/ai-task.md", ".github/pull_request_template.md",
  ".github/workflows/ci.yml",
];
const linkedMarkdown = required.filter((name) => name.endsWith(".md"));

function markdownProse(value) {
  let fence = null;
  const result = [];
  for (const line of value.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      result.push("");
      continue;
    }
    result.push(fence ? "" : line.replace(/`[^`\n]+`/g, ""));
  }
  return result.join("\n");
}

export function inspectProject(projectRoot = defaultRoot) {
  const errors = [];
  const read = (file) => {
    const location = resolve(projectRoot, file);
    if (!existsSync(location)) { errors.push(`Missing file: ${file}`); return null; }
    const contents = readFileSync(location, "utf8");
    if (!contents.trim()) errors.push(`Empty file: ${file}`);
    return contents;
  };
  const files = new Map(required.map((file) => [file, read(file)]));
  const claude = files.get("CLAUDE.md");
  if (claude !== null && claude.trim() !== "@AGENTS.md") {
    errors.push("CLAUDE.md must only import AGENTS.md; do not duplicate rules");
  }

  const packageSource = files.get("package.json");
  if (packageSource !== null) {
    try {
      const json = JSON.parse(packageSource);
      const command = json?.scripts?.["governance:check"];
      if (typeof command !== "string" || !/node\s+scripts\/check-agent-governance\.mjs\b/.test(command)) {
        errors.push("package.json must register the governance structure check");
      }
    } catch { errors.push("package.json is not valid JSON"); }
  }
  const workflow = files.get(".github/workflows/ci.yml");
  if (workflow !== null && !/^\s*run:\s*pnpm governance:check\s*$/m.test(workflow)) {
    errors.push("CI must invoke pnpm governance:check");
  }

  const issue = files.get(".github/ISSUE_TEMPLATE/ai-task.md");
  if (issue !== null) {
    const normalized = issue.replace(/\r\n/g, "\n");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(normalized)?.[1];
    if (!frontmatter || !/^name:\s*\S/m.test(frontmatter) || !/^about:\s*\S/m.test(frontmatter)) {
      errors.push("GitHub Issue template needs valid name/about frontmatter");
    }
  }

  for (const file of linkedMarkdown) {
    const contents = files.get(file);
    if (contents === null) continue;
    const prose = markdownProse(contents);
    for (const match of prose.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
      const raw = match[1].trim().replace(/^<(.+)>$/, "$1");
      const plain = raw.split("#", 1)[0];
      if (!plain || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(plain)) continue;
      let target;
      try { target = decodeURIComponent(plain); }
      catch { errors.push(`${file}: invalid link encoding`); continue; }
      const absolute = resolve(projectRoot, dirname(file), target);
      const fromRoot = relative(projectRoot, absolute);
      if (fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) {
        errors.push(`${file}: link escapes repository: ${raw}`);
      } else if (!existsSync(absolute)) {
        errors.push(`${file}: broken link: ${raw}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = inspectProject();
  if (errors.length) {
    for (const issue of errors) console.error(`AI governance: ${issue}`);
    process.exitCode = 1;
  } else {
    console.log("AI governance structure passed: instruction entry, GitHub templates, CI and document links.");
  }
}
