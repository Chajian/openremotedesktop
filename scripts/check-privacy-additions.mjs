import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateOperationsPath, privacyFindingsInDiff } from "./private-data-policy.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] ?? "--staged";
if (!["--staged", "--branch"].includes(mode)) {
  throw new Error("Usage: node scripts/check-privacy-additions.mjs [--staged|--branch]");
}
function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}
function gitOrNull(...args) {
  try { return git(...args); } catch { return null; }
}
function branchRange() {
  const target = process.env.GITHUB_BASE_REF || "master";
  if (/^[A-Za-z0-9._/-]+$/.test(target) && !target.startsWith("/")) {
    const reference = `refs/remotes/origin/${target}`;
    const baseSha = gitOrNull("rev-parse", "--verify", reference)?.trim();
    const headSha = git("rev-parse", "HEAD").trim();
    if (baseSha && baseSha !== headSha) return `${reference}..HEAD`;
  }
  return gitOrNull("rev-parse", "--verify", "HEAD^") ? "HEAD^..HEAD" : null;
}

const problems = new Set();
const indexNames = git("ls-files", "-z").split("\0").filter(Boolean);
for (const name of indexNames) {
  if (privateOperationsPath(name)) problems.add(`${name} (private operations file)`);
}
let changes = "";
let changedNames = [];
if (mode === "--staged") {
  changes = git("diff", "--cached", "--no-ext-diff", "--unified=0", "--diff-filter=ACMR");
  changedNames = git("diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean);
} else {
  const range = branchRange();
  if (range) {
    changes = git("log", "--format=", "--no-ext-diff", "--unified=0", "-p", range);
    changedNames = git("log", "--format=", "--name-only", range).split(/\r?\n/).filter(Boolean);
  } else {
    changes = git("show", "--format=", "--no-ext-diff", "--unified=0", "HEAD");
  }
}
for (const name of changedNames) {
  if (privateOperationsPath(name)) problems.add(`${name} (private operations file)`);
}
for (const issue of privacyFindingsInDiff(changes)) problems.add(issue);
if (problems.size) {
  console.error("Public-repository privacy check failed. No sensitive values are shown.");
  for (const issue of [...problems].slice(0, 40)) console.error(`  ${issue}`);
  if (problems.size > 40) console.error(`  ...and ${problems.size - 40} other findings`);
  process.exitCode = 1;
} else {
  console.log(`Public-repository privacy check passed (${mode} + tracked path protections).`);
}
