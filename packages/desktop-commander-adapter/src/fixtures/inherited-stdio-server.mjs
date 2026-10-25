import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [mode, directory] = process.argv.slice(2);
if (mode === "descendant") {
  // Only the fixture's private stop file controls this descendant. Production
  // cleanup must neither signal it nor take ownership of its process tree.
  const poll = setInterval(() => {
    if (existsSync(join(directory, "stop-descendant"))) process.exit(0);
  }, 20);
  process.on("exit", () => {
    clearInterval(poll);
    writeFileSync(join(directory, "descendant-exited"), String(process.pid));
  });
  setTimeout(() => process.exit(1), 30_000);
  process.send?.("ready");
} else {
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant", directory], {
    stdio: ["ignore", process.stdout, process.stderr, "ipc"],
    // Keep the fixture-owned descendant alive after its parent exits on Windows;
    // its private stop file, not the parent's job, controls teardown.
    detached: process.platform === "win32",
    windowsHide: true,
  });
  descendant.on("error", error => { throw error; });
  await new Promise(resolve => descendant.once("message", resolve));
  descendant.disconnect();
  writeFileSync(join(directory, "ready.json"), JSON.stringify({ descendantPid: descendant.pid }));
  if (mode === "eof") process.stdin.on("end", () => process.exit(0));
  else setInterval(() => {}, 1_000);
  process.on("SIGTERM", () => { if (mode !== "kill") process.exit(0); });
  setTimeout(() => process.exit(1), 30_000);
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const result = request.method === "initialize"
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "inherited-stdio-fixture", version: "0.3.1" } }
      : request.method === "tools/list"
        ? { tools: [{ name: "fixture_status", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "fixture ready" }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  }
}
