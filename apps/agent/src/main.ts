import { parseAgentCommand } from "./index.js";
import { runAgentConnect } from "./runtime.js";

if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2] ?? "")) {
  console.log("Usage: open-desktop-remote-agent agent connect --server https://remote.example.com");
  process.exit(0);
}

const command = parseAgentCommand(process.argv.slice(2));
const controller = new AbortController();

function stop() {
  controller.abort();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await runAgentConnect(command.serverUrl, controller.signal);
