import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = resolve(process.argv[2] || "dist/agent-install-check");
const require = createRequire(join(install, "node_modules", "open-desktop-remote-agent", "package.json"));
const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
const { Client } = await load("@modelcontextprotocol/client");
const { StdioClientTransport } = await load("@modelcontextprotocol/client/stdio");
const commander = join(dirname(require.resolve("@wonderwhy-er/desktop-commander/package.json")), "dist", "index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [commander, "--no-onboarding"],
  stderr: "pipe",
});
const client = new Client({ name: "npm-install-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  if (tools.length !== 26) throw new Error("Expected 26 Desktop Commander tools, got " + tools.length);
  console.log("npm-installed Desktop Commander exposes 26 tools.");
} finally {
  await client.close().catch(() => undefined);
}
