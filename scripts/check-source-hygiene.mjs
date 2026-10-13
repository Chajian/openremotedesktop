import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const flags = new Set(process.argv.slice(2));
if ([...flags].some((f) => !["--staged", "--history", "--all"].includes(f))) {
  throw new Error("Usage: node scripts/check-source-hygiene.mjs [--staged|--history|--all]");
}
const checkIndex = !flags.size || flags.has("--staged") || flags.has("--all");
const checkHistory = !flags.size || flags.has("--history") || flags.has("--all");
const git = (...args) => execFileSync("git", args, {
  cwd: root, encoding: "buffer", windowsHide: true, maxBuffer: 128 * 1024 * 1024,
});
const errors = new Set();
let inspected = 0;
const blockedDirectories = new Set([
  ".ssh", ".aws", ".azure", ".kube", ".codex", ".superpowers",
  ".terraform", "secrets", "private-secrets", "private-data", "backups",
]);
const blockedExactNames = new Set([
  ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_dsa", "id_ecdsa",
  "id_ed25519", "credentials.json", "secrets.json", "device.json",
  "owner-password.txt", "service-account.json", "google-credentials.json",
]);
function forbiddenPath(name) {
  const path = name.replaceAll("\\", "/");
  const parts = path.split("/");
  const file = parts.at(-1).toLowerCase();
  if (parts.slice(0, -1).some((p) => blockedDirectories.has(p.toLowerCase()))) return true;
  if (file === ".env" || (file.startsWith(".env.") && file !== ".env.example")) return true;
  if (blockedExactNames.has(file)) return true;
  if (/\.(?:pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|sqlite3?|db|db-wal|db-shm|jsonl|log|bak|backup|zip|7z|rar|tgz|tar|tar\.gz)$/i.test(file)) return true;
  if (/^(?:scripts\/(?:check-windows-identity\.cjs|online-windows\.ps1|online-mac\.command)|两台设备上线\.cmd|设备上线-Windows\.cmd|docs\/vps-multiuser-upgrade-preflight\.zh-CN\.md)$/i.test(path)) return true;
  return false;
}
const patterns = [
  ["private key", /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{25,})\b/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{25,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{25,}\b/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{18,}\b/g],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{16,}\b/g],
  ["Stripe live key", /\b(?:sk_live|rk_live)_[A-Za-z0-9]{16,}\b/g],
  ["credentials in URL", /\b(?:https?|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]{3,}@/g],
  ["private network", /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
];
const assignedSecret = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?(?:token|credential)|client[_-]?secret|password|passphrase)\s*[:=]\s*["'\x60]([A-Za-z0-9_+\-\/=.!]{32,})["'\x60]/gi;
function likelySecret(value) {
  if (/(?:example|test|fixture|dummy|fake|sample|placeholder|replace|changeme|local-only|for-test)/i.test(value)) return false;
  if (new Set(value).size < 15) return false;
  const counts = new Map();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) { const p = n / value.length; entropy -= p * Math.log2(p); }
  return entropy >= 3.8;
}
const oldUrl = ["github.com", "Chajian", "open-desktop-remote"].join("/");
function inspectContent(path, data, scope) {
  if (data.length > 3_000_000 || data.includes(0)) return;
  inspected++;
  const value = data.toString("utf8");
  for (const [name, regex] of patterns) {
    regex.lastIndex = 0;
    const match = regex.exec(value);
    if (match) errors.add(scope + ": " + path + " (" + name + ")");
  }
  assignedSecret.lastIndex = 0;
  let match;
  while ((match = assignedSecret.exec(value))) {
    if (likelySecret(match[1])) errors.add(scope + ": " + path + " (high-entropy credential assignment)");
  }
  if (value.includes(oldUrl)) errors.add(scope + ": " + path + " (outdated repository URL)");
}
function scanBatch(items, scope) {
  if (!items.size) return;
  const ids = [...items.keys()];
  const input = Buffer.from(ids.join("\n") + "\n");
  const raw = gitBatch(input);
  let offset = 0;
  for (const id of ids) {
    const end = raw.indexOf(10, offset);
    if (end === -1) throw new Error("Incomplete git cat-file batch header");
    const header = raw.toString("utf8", offset, end);
    const m = /^([a-f0-9]{40,64}) (blob|commit|tree|tag) (\d+)$/.exec(header);
    if (!m || m[1] !== id) throw new Error("Unexpected git cat-file object");
    const size = Number(m[3]);
    const contents = raw.subarray(end + 1, end + 1 + size);
    offset = end + 2 + size;
    if (m[2] !== "blob" && m[2] !== "commit" && m[2] !== "tag") continue;
    for (const path of items.get(id)) inspectContent(path, contents, scope);
  }
}
function gitBatch(input) {
  return execFileSync("git", ["cat-file", "--batch"], {
    cwd: root, input, maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  });
}
if (checkIndex) {
  const blobs = new Map();
  const entries = git("ls-files", "--stage", "-z").toString("utf8").split("\0").filter(Boolean);
  for (const row of entries) {
    const m = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!m) throw new Error("Invalid Git index entry");
    const path = m[4];
    if (forbiddenPath(path)) errors.add("index: " + path + " (prohibited private file)");
    if (m[3] !== "0") errors.add("index: " + path + " (unresolved merge entry)");
    if (!blobs.has(m[2])) blobs.set(m[2], new Set());
    blobs.get(m[2]).add(path);
  }
  scanBatch(blobs, "index");
}
if (checkHistory) {
  const objects = new Map();
  for (const row of git("rev-list", "--objects", "--all").toString("utf8").split("\n").filter(Boolean)) {
    const m = /^([a-f0-9]{40,64})(?: (.*))?$/.exec(row);
    if (!m) throw new Error("Invalid Git object listing");
    const path = m[2] || "<Git metadata>";
    if (m[2] && forbiddenPath(path)) errors.add("history: " + path + " (prohibited private path)");
    if (!objects.has(m[1])) objects.set(m[1], new Set());
    objects.get(m[1]).add(path);
  }
  scanBatch(objects, "history");
}
if (errors.size) {
  console.error("Secret and private-file guard failed. Values are never printed.");
  for (const issue of [...errors].slice(0, 60)) console.error("  " + issue);
  if (errors.size > 60) console.error("  ...and " + (errors.size - 60) + " more findings");
  process.exitCode = 1;
} else {
  console.log("Secret guard passed: " + inspected + " text objects checked (" +
    (checkIndex ? "staged index" : "") +
    (checkIndex && checkHistory ? " + " : "") +
    (checkHistory ? "all reachable Git history" : "") + ").");
}
