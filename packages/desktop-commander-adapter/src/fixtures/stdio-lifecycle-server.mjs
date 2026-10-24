import { createInterface } from "node:readline";
import { once } from "node:events";

// A local MCP fixture: no network, filesystem access, or real tool execution.
const mode = process.argv[2];
const stubborn = mode === "stubborn" || mode === "reject-stubborn";
if (stubborn) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  process.stdin.on("end", () => process.exit(0));
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method !== "initialize") continue;

  if (mode === "stderr-flood") {
    const chunk = "fixture stderr must stay private\n".repeat(2_048);
    for (let index = 0; index < 128; index += 1) {
      if (!process.stderr.write(chunk)) await once(process.stderr, "drain");
    }
  }

  const response = mode === "reject" || mode === "reject-stubborn"
    ? { error: { code: -32603, message: "Fixture initialization rejected" } }
    : {
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: "stdio-lifecycle-fixture",
          version: mode === "version-mismatch" ? "1.0.0" : "0.3.1",
        },
      },
    };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }) + "\n");
}
