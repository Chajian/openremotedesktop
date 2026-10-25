import { createInterface } from "node:readline";

// Real MCP initialization failures with explicit request/EOF observations.
const mode = process.argv[2];
process.stdin.on("end", () => {
  process.stderr.write("EVENT:stdin-ended\n", () => process.exit(0));
});
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method !== "initialize") continue;
  process.stderr.write("REQUEST:initialize\n");
  if (mode === "exit17") {
    process.stderr.write("EVENT:exit17\n", () => process.exit(17));
    continue;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: request.id,
    error: { code: -32603, message: "Fixture initialization refused" },
  }) + "\n");
}
