export * from "./auth/device-token.js";
export * from "./credentials/credential-store.js";
export * from "./executor/executor-manager.js";
export * from "./http/server-client.js";
export * from "./logging.js";
export * from "./pairing/pair-device.js";
export * from "./relay/relay-client.js";
export * from "./runtime.js";

export type AgentCommand = {
  command: "connect";
  serverUrl: URL;
};

export function parseAgentCommand(args: string[]): AgentCommand {
  if (
    args[0] !== "agent" ||
    args[1] !== "connect" ||
    args[2] !== "--server" ||
    typeof args[3] !== "string" ||
    args.length !== 4
  ) {
    throw new Error(
      "Usage: agent connect --server https://remote.example.com",
    );
  }

  const serverUrl = new URL(args[3]);
  if (!["http:", "https:"].includes(serverUrl.protocol)) {
    throw new Error("Server URL must use http or https");
  }
  return { command: "connect", serverUrl };
}
