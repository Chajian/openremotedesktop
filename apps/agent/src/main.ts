import { parseAgentCommand } from "./index.js";
import { runAgentConnect } from "./runtime.js";
import { ServerResponseError } from "./http/server-client.js";

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

try {
  await runAgentConnect(command.serverUrl, controller.signal);
} catch (error) {
  // Runtime callers retain the original causes. CLI diagnostics must not let
  // Node recursively print arbitrary upstream payloads from errors or causes.
  console.error(error instanceof ServerResponseError
    ? "Agent received an invalid server response. Check the server endpoint and retry."
    : error instanceof AggregateError
      ? "Agent stopped after an initialization or shutdown failure. Subprocess shutdown could not be confirmed."
      : "Agent connection failed. Check device authorization, network, and the packaged executor.");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
