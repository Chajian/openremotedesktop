// Test fixture: a valid local MCP stdio server that never replies to tool calls.
// No external process, user filesystem path or network access is required.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
};
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "hung-local-stdio-test", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    respond(message.id, { tools: [
      { name: "write_file", inputSchema: { type: "object", properties: {} } },
    ] });
  } else if (message.method === "tools/call") {
    if (process.env.ODR_TEST_CALL_LOG) {
      appendFileSync(process.env.ODR_TEST_CALL_LOG, "called\n");
    }
    // Deliberately keep this process and its stdio connection alive.
  }
}
