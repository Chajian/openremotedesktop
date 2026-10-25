import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = resolve(process.argv[2] || "dist/agent-install-check");
const require = createRequire(join(install, "node_modules", "open-desktop-remote-agent", "package.json"));
const pkg = require("./package.json");
const release = JSON.parse(await readFile(new URL("../apps/agent/src/version.json", import.meta.url), "utf8"));
const adapter = JSON.parse(await readFile(new URL("../packages/desktop-commander-adapter/package.json", import.meta.url), "utf8"));
assert.equal(pkg.name, "open-desktop-remote-agent", "Installed Agent package name differs");
assert.equal(pkg.version, release.version, "Installed Agent version differs from the source release");
assert.equal(pkg.dependencies?.["@wonderwhy-er/desktop-commander"], adapter.dependencies["@wonderwhy-er/desktop-commander"], "Installed Agent Desktop Commander pin differs");
const manifest = JSON.parse(await readFile(new URL("../packages/tool-contracts/src/manifest.generated.json", import.meta.url), "utf8"));
const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
const { Client } = await load("@modelcontextprotocol/client");
const { StdioClientTransport } = await load("@modelcontextprotocol/client/stdio");
const commander = join(dirname(require.resolve("@wonderwhy-er/desktop-commander/package.json")), "dist", "index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [commander, "--no-onboarding"],
  stderr: "pipe",
});
const closed = Promise.withResolvers();
transport.onclose = () => closed.resolve();
transport.stderr?.on("data", () => {});
const client = new Client({ name: "npm-install-smoke", version: "0.1.0" });
let failed = false;
let failure;
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, pkg.dependencies["@wonderwhy-er/desktop-commander"]);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), manifest.map(tool => tool.name).sort());
  for (const expected of manifest) {
    const tool = tools.find(tool => tool.name === expected.name);
    assert.deepEqual(tool.inputSchema, expected.inputSchema);
    assert.deepEqual(tool.outputSchema, expected.outputSchema);
    assert.deepEqual(tool.annotations, expected.annotations);
  }
  console.log(`npm-installed Desktop Commander ${client.getServerVersion().version}: ${tools.length} tool schemas and annotations verified.`);
} catch (error) {
  failed = true;
  failure = error;
  throw error;
} finally {
  let timer;
  try {
    await client.close();
    await Promise.race([
      closed.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Packaged Desktop Commander subprocess close was not confirmed")), 2_000);
      }),
    ]);
  } catch (shutdownError) {
    if (failed) throw new AggregateError([failure, shutdownError], "Packaged Agent verification failed and shutdown was not confirmed");
    throw shutdownError;
  } finally { clearTimeout(timer); }
}
