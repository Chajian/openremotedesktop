import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// An existing npm version is immutable. Even matching metadata is not proof
// that a rebuilt tarball has identical contents, so publication never skips it.
export async function assertAgentVersionAvailable(pkg, { fetchImpl = fetch } = {}) {
  if (pkg?.name !== "open-desktop-remote-agent" ||
      typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error("Expected open-desktop-remote-agent with a stable semver version");
  }
  const identity = `${pkg.name}@${pkg.version}`;
  let response;
  try {
    response = await fetchImpl(`https://registry.npmjs.org/${pkg.name}/${pkg.version}`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw new Error(`Could not verify ${identity} against the npm registry; staging is blocked`, { cause });
  }
  if (response.status === 404) return;
  if (response.status === 200) {
    throw new Error(`${identity} is already published; choose a new version before staging. ` +
      "To rebuild existing GitHub downloads only, use workflow_dispatch with release_tag.");
  }
  throw new Error(`npm registry returned HTTP ${response.status} for ${identity}; staging is blocked`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(await readFile(new URL("../dist/agent-npm/package.json", import.meta.url), "utf8"));
  await assertAgentVersionAvailable(pkg);
  console.log(`Verified ${pkg.name}@${pkg.version} is not published (no publication performed).`);
}
