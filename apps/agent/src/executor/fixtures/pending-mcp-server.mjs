import { createInterface } from "node:readline";

// A fixture-owned MCP server that can withhold one initialization response.
// It exits on stdin EOF, so cancellation must reach the real transport.
const mode = process.argv[2];
process.stdin.on("end", () => process.exit(0));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stderr.write("REQUEST:initialize\n");
    if (mode === "handshake") continue;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "pending-fixture", version: "0.3.1" },
    } }) + "\n");
  } else if (request.method === "tools/list") {
    process.stderr.write("REQUEST:tools/list\n");
    if (mode === "tools") continue;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      tools: [{ name: "read_file", inputSchema: { type: "object" } }],
    } }) + "\n");
  }
}
