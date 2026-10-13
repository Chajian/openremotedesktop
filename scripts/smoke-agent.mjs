import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 24) {
  console.error(`Agent smoke requires Node.js 24+, got ${process.version}`);
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = resolve(repoRoot, "apps", "agent");
const agentRequire = createRequire(resolve(agentRoot, "package.json"));
const tsxLoader = pathToFileURL(agentRequire.resolve("tsx/esm")).href;

const probe = String.raw`
import { parseAgentCommand } from "./src/index.ts";
import { createCredentialStore } from "./src/credentials/credential-store.ts";
import { ExecutorManager } from "./src/executor/executor-manager.ts";
import { PROTOCOL_VERSION } from "../../packages/protocol/src/index.ts";

const command = parseAgentCommand([
  "agent",
  "connect",
  "--server",
  "https://smoke.example.test",
]);
if (command.serverUrl.toString() !== "https://smoke.example.test/") {
  throw new Error("Agent CLI parser did not preserve the server URL");
}
if (typeof createCredentialStore !== "function") {
  throw new Error("Credential store module did not load");
}
if (typeof ExecutorManager !== "function") {
  throw new Error("Executor manager module did not load");
}
if (PROTOCOL_VERSION !== 1) {
  throw new Error("Unexpected protocol version");
}
console.log("agent-smoke-ok");
`;

const result = spawnSync(
  process.execPath,
  ["--import", tsxLoader, "--input-type=module", "--eval", probe],
  {
    cwd: agentRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
