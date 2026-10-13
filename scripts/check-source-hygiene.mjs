import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(Boolean);
const unsafePaths = [
  /^\.env(?!\.example$)/i,
  /(^|\/)\.(?:npmrc|ssh|aws|codex)(?:\/|$)/i,
  /(^|\/)\.superpowers\//i,
  /\.(?:pem|p12|pfx|ppk|sqlite|db|zip|bak|backup)$/i,
  /^scripts\/(?:check-windows-identity\.cjs|online-windows\.ps1|online-mac\.command)$/i,
];
const indicators = [
  ["Private key", /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/],
  ["GitHub access token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{25,})\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/],
  ["Embedded URL credentials", /\b(?:https?|mongodb(?:\+srv)?):\/\/[^\/\s@:]+:[^\/@\s]+@/],
  ["Private infrastructure IPv4", /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/],
];
const legacyHost = ["github.com", "Chajian", "open-desktop-remote"].join("/");
let scanned = 0;
const violations = [];
for (const name of tracked) {
  const normalized = name.replaceAll("\\", "/");
  if (unsafePaths.some((rule) => rule.test(normalized))) {
    violations.push(name + ": prohibited tracked file");
    continue;
  }
  const raw = readFileSync(join(root, name));
  if (raw.length > 3_000_000 || raw.includes(0)) continue;
  scanned++;
  const value = raw.toString("utf8");
  for (const [label, pattern] of indicators) {
    if (pattern.test(value)) violations.push(name + ": " + label);
  }
  if (value.includes(legacyHost)) violations.push(name + ": old GitHub repository reference");
}
if (violations.length) {
  console.error("Repository hygiene checks failed:\n" + [...new Set(violations)].join("\n"));
  process.exitCode = 1;
} else {
  console.log("Repository hygiene passed for " + scanned + " source text files.");
}
