import { parseAgentCommand } from "./index.js";
import { runAgentConnect } from "./runtime.js";
import { runSupportConnect, SupportConsentDeniedError } from "./support/support-client.js";
import { ServerResponseError } from "./http/server-client.js";

if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2] ?? "")) {
  console.log("Usage: agent connect --server URL | agent support --server URL --invite TOKEN");
  process.exit(0);
}

const command = parseAgentCommand(process.argv.slice(2));
const controller = new AbortController();

function stop() {
  if (controller.signal.aborted) return;
  if (command.command === "support") console.log("Ending temporary support. Please wait for revocation to finish.");
  controller.abort();
}

// Keep handling repeated signals while executor shutdown and support revocation
// are pending. A once listener restores Node's default termination too early.
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  if (command.command === "support") await runSupportConnect(command.serverUrl, command.invite, controller.signal);
  else await runAgentConnect(command.serverUrl, controller.signal);
} catch (error) {
  // Runtime callers retain the original causes. CLI diagnostics must not let
  // Node recursively print arbitrary upstream payloads from errors or causes.
  console.error(error instanceof SupportConsentDeniedError
    ? "Support not approved. No remote access was granted."
    : error instanceof ServerResponseError
    ? "Agent received an invalid server response. Check the server endpoint and retry."
    : error instanceof AggregateError
      ? "Agent stopped after an initialization or shutdown failure. Subprocess shutdown could not be confirmed."
      : "Agent connection failed. Check device authorization, network, and the packaged executor.");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
