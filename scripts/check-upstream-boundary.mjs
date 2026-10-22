#!/usr/bin/env node
// An auditable boundary check, not a proof that arbitrary code is nonmalicious.
// The JSON baseline records the original npm tarball's published files; it does
// not contain or vendor upstream implementation. See its package/integrity fields.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const published = JSON.parse(readFileSync(new URL("./upstream-desktop-commander-0.2.52.json", import.meta.url), "utf8"));
const upstream = "@wonderwhy-er/desktop-commander";
const version = "0.2.52";
const integrity = "sha512-VNeKfaBR6TN/8MlP/ziTpjNEeHrGOFmmzQjrwzr52kQalBJoNNISWwaSQElPFc6+I17NOOM354KbSdS/aDrqGA==";
const launcher = "packages/desktop-commander-adapter/src/desktop-commander-client.ts";
const launcherHash = "716855c3de2590a0f994aabd4eb6b2b6a1f946619ccdbcb3f86510378e74fba8";
const resolutionFiles = new Set([launcher, "scripts/smoke-packaged-agent.mjs"]);
const ignoredDirectories = new Set(["node_modules", "dist", "build", "coverage", ".git", ".superpowers", "__fixtures__", "fixtures", "__tests__"]);
const codeExtension = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|fish|ps1|bat|cmd|py|rb|pl|lua|wasm|node|exe|dll|so|dylib)$/i;
const sourceExtension = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|ps1|bat|cmd|py)$/i;
const result = (errors, extra = {}) => ({ ok: errors.length === 0, errors, ...extra });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slash = (path) => path.replaceAll("\\", "/");
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, "$2");

function walk(directory, visit, ignored = ignoredDirectories) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) walk(path, visit, ignored);
    } else visit(path, entry);
  }
}

// These readers intentionally accept pnpm's generated block layout rather than
// claim to implement YAML. Unsupported identity syntax fails the expected shape.
function block(text, key, indentation) {
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => {
    const match = /^( *)(.+):\s*(?:#.*)?$/.exec(line);
    return match && match[1].length === indentation && unquote(match[2]) === key ? [index] : [];
  });
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^\s*#/.test(lines[end]) || lines[end].search(/\S/) > indentation)) end++;
  return lines.slice(start + 1, end).join("\n");
}
function scalar(text, key, indentation) {
  if (text === undefined) return undefined;
  const matches = text.split(/\r?\n/).flatMap((line) => {
    const match = /^( *)([^:]+):\s*(.*?)\s*$/.exec(line);
    return match && match[1].length === indentation && unquote(match[2]) === key ? [unquote(match[3])] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}
function checkLock(text, errors) {
  const importers = block(text, "importers", 0);
  const adapter = importers === undefined ? undefined : block(importers, "packages/desktop-commander-adapter", 2);
  const dependencies = adapter === undefined ? undefined : block(adapter, "dependencies", 4);
  const dependency = dependencies === undefined ? undefined : block(dependencies, upstream, 6);
  if (scalar(dependency, "specifier", 8) !== version || scalar(dependency, "version", 8) !== version) {
    errors.push("pnpm-lock.yaml: lockfile adapter specifier/version must be exactly 0.2.52.");
  }
  const packages = block(text, "packages", 0);
  const record = packages === undefined ? undefined : block(packages, `${upstream}@${version}`, 2);
  if (scalar(record, "resolution", 4) !== `{integrity: ${integrity}}`) {
    errors.push("pnpm-lock.yaml: lockfile upstream resolution must contain only the original npm tarball integrity.");
  }
  const identities = (packages ?? "").split(/\r?\n/).filter((line) => /^  \S/.test(line) && line.includes(upstream));
  if (identities.length !== 1 || !identities[0].includes(`${upstream}@${version}`)) {
    errors.push("pnpm-lock.yaml: lockfile must have one original upstream package identity and no alternative source.");
  }
  if (/^\s*(?:patchedDependencies|overrides|packageExtensions):/m.test(text)) {
    errors.push("pnpm-lock.yaml: lockfile patch/replacement configuration is forbidden.");
  }
}
function containsUpstream(value) { return JSON.stringify(value ?? {}).includes(upstream); }
function checkManifest(manifest, path, errors) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if ((name === upstream || String(specifier).includes(upstream)) && (name !== upstream || specifier !== version)) {
        errors.push(`${path}: upstream dependency must use the exact original 0.2.52 npm source.`);
      }
      if (name === "patch-package") errors.push(`${path}: patch-package is forbidden at the upstream boundary.`);
    }
  }
  for (const config of [manifest, manifest.pnpm ?? {}]) {
    for (const key of ["overrides", "resolutions", "packageExtensions", "patchedDependencies"]) {
      if ((key === "patchedDependencies" && Object.keys(config[key] ?? {}).length) || containsUpstream(config[key])) {
        errors.push(`${path}: upstream patch/replacement configuration (${key}) is forbidden.`);
      }
    }
  }
  // Our workspace has no dependency-install hooks. Forbid adding code execution
  // there; never apply this rule to upstream's original, hash-verified manifest.
  for (const name of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
    if (manifest.scripts?.[name]?.trim()) errors.push(`${path}: workspace lifecycle hook ${name} requires boundary review and is forbidden.`);
  }
  for (const command of Object.values(manifest.scripts ?? {})) {
    if (/patch-package|pnpm\s+patch\b/.test(command) || (command.includes(upstream) && /(?:node_modules|patch|rewrite)/i.test(command))) {
      errors.push(`${path}: obvious upstream package-rewrite script is forbidden.`);
    }
  }
}

// Literal implementation references are forbidden even through an aliased loader.
// Inspection skips comments; computed/obfuscated paths and indirect mutations
// still need code review. The two package.json exceptions allow require.resolve.
function tokens(source) {
  const output = [];
  const matcher = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g;
  for (const match of source.matchAll(matcher)) {
    const raw = match[0];
    if (raw.startsWith("//") || raw.startsWith("/*")) continue;
    if (/^["'`]/.test(raw)) output.push({ type: "string", value: raw.slice(1, -1), at: match.index });
    else output.push({ type: "code", value: raw, at: match.index });
  }
  return output;
}
function checkSource(source, path, errors) {
  const parts = tokens(source);
  for (let index = 0; index < parts.length; index++) {
    const token = parts[index];
    if (token.type !== "string" || !token.value.includes(`${upstream}/`)) continue;
    const before = parts.slice(Math.max(0, index - 4), index).map((part) => part.value).join(" ");
    const allowed = token.value === `${upstream}/package.json` && resolutionFiles.has(path) && /\brequire\s*\.\s*resolve\s*\(\s*$/.test(before);
    if (!allowed) errors.push(`${path}: deep upstream import/require, implementation reference or unauthorized package.json resolution is forbidden.`);
  }
  const writes = parts.some((token) => token.type === "code" && /^(?:writeFile(?:Sync)?|appendFile(?:Sync)?|copyFile(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|truncate(?:Sync)?|patch)$/.test(token.value));
  const implementationPath = parts.some((token) => token.type === "string" && token.value.includes(upstream) && /node_modules|\/dist\//.test(token.value));
  if (writes && implementationPath) errors.push(`${path}: obvious upstream implementation rewrite is forbidden.`);
}

/** Read-only verification of original published bytes and added code. */
export function checkInstalledPackage({ installedPackagePath, baseline = published }) {
  const errors = [];
  let packageRoot;
  try { packageRoot = realpathSync(installedPackagePath); }
  catch { return result(["Installed upstream package is missing or unreadable."]); }
  let checkedFiles = 0;
  for (const [path, expected] of Object.entries(baseline.files)) {
    const full = join(packageRoot, path);
    try {
      // Refuse symlinked published files or parent directories, while allowing
      // the package directory itself to be a normal pnpm symlink.
      let current = packageRoot;
      for (const component of path.split("/")) {
        current = join(current, component);
        if (lstatSync(current).isSymbolicLink()) throw new Error("symlink");
      }
      if (!lstatSync(full).isFile() || hash(readFileSync(full)) !== expected) errors.push(`Installed upstream modified published file: ${path}`);
      checkedFiles++;
    } catch (error) {
      errors.push(`Installed upstream ${error.message === "symlink" ? "symlink in" : "missing/unreadable"} published file: ${path}`);
    }
  }
  // Runtime data and dependency closures are outside this published-file set.
  // Added code, executable bits, shebangs and symlinks are rejected elsewhere.
  try {
    walk(packageRoot, (full, entry) => {
      const path = slash(relative(packageRoot, full));
      if (Object.hasOwn(baseline.files, path)) return;
      const stat = lstatSync(full);
      if (entry.isSymbolicLink() || codeExtension.test(path) || (stat.mode & 0o111) || (stat.isFile() && readFileSync(full).subarray(0, 2).toString() === "#!")) {
        errors.push(`Installed upstream added executable/code file or symlink: ${path}`);
      }
    }, new Set(["node_modules"]));
  } catch { errors.push("Installed upstream package tree is unreadable."); }
  return result(errors, { checkedFiles });
}

/** Check repository policy; by default also verify the adapter's installed package. */
export function checkUpstreamBoundary({ root = defaultRoot, installedPackagePath, sourceOnly = false } = {}) {
  root = resolve(root);
  const errors = [];
  if (published.package !== upstream || published.version !== version || published.integrity !== integrity || published.algorithm !== "sha256" || Object.keys(published.files).length !== 249) {
    errors.push("Published upstream hash baseline identity is invalid.");
  }
  try {
    const manifests = [join(root, "package.json")];
    for (const folder of ["apps", "packages"]) walk(join(root, folder), (path) => { if (basename(path) === "package.json") manifests.push(path); });
    for (const path of manifests) checkManifest(JSON.parse(readFileSync(path, "utf8")), slash(relative(root, path)), errors);
    const adapter = JSON.parse(readFileSync(join(root, "packages/desktop-commander-adapter/package.json"), "utf8"));
    if (adapter.dependencies?.[upstream] !== version) errors.push("Adapter must pin upstream to exact original 0.2.52 npm source.");
    checkLock(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), errors);
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    if (/^\s*['"]?(?:overrides|resolutions|patchedDependencies|packageExtensions|pnpmfile|globalPnpmfile)['"]?\s*:/m.test(workspace)) {
      errors.push("pnpm-workspace.yaml: patch/replacement/hook configuration requires boundary review and is forbidden.");
    }
    for (const path of [root, ...manifests.map(dirname)]) {
      for (const name of [".pnpmfile.cjs", ".pnpmfile.js", ".pnpmfile.mjs", "pnpmfile.cjs"]) {
        if (existsSync(join(path, name))) errors.push(`${slash(relative(root, join(path, name)))}: pnpmfile hooks are forbidden.`);
      }
    }
    if (hash(readFileSync(join(root, launcher))) !== launcherHash) errors.push(`${launcher}: runtime launcher must remain unchanged from the approved baseline.`);
    for (const folder of ["apps", "packages", "scripts"]) {
      walk(join(root, folder), (path, entry) => {
        const name = slash(relative(root, path));
        if (/\.(?:test|spec)\.[^.]+$/.test(name) || !sourceExtension.test(name)) return;
        if (entry.isSymbolicLink()) errors.push(`${name}: source symlink requires boundary review.`);
        else checkSource(readFileSync(path, "utf8"), name, errors);
      });
    }
  } catch (error) { errors.push(`Cannot inspect upstream source boundary: ${error.code ?? error.name}.`); }
  let checkedFiles = 0;
  if (!sourceOnly) {
    try {
      const path = installedPackagePath ?? dirname(createRequire(join(root, "packages/desktop-commander-adapter/package.json")).resolve(`${upstream}/package.json`));
      const installed = checkInstalledPackage({ installedPackagePath: path });
      errors.push(...installed.errors); checkedFiles = installed.checkedFiles ?? 0;
    } catch { errors.push("Cannot resolve installed upstream through adapter; install dependencies or pass --installed-package PATH (or --source-only for static checks)."); }
  }
  return result([...new Set(errors)], { checkedFiles, sourceOnly });
}

function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--source-only") options.sourceOnly = true;
    else if ((arg === "--root" || arg === "--installed-package") && args[index + 1] && !args[index + 1].startsWith("--")) {
      options[arg === "--root" ? "root" : "installedPackagePath"] = resolve(args[++index]);
    } else {
      console.error("Usage: node scripts/check-upstream-boundary.mjs [--root PATH] [--installed-package PATH] [--source-only]");
      return 2;
    }
  }
  const checked = checkUpstreamBoundary(options);
  if (!checked.ok) {
    for (const error of checked.errors) console.error(`Upstream boundary: ${error}`);
    return 1;
  }
  console.log(`Upstream boundary verified (${checked.sourceOnly ? "source only; installed package not checked" : `${checked.checkedFiles} original published files`}).`);
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
