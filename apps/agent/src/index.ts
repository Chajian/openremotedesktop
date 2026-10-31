export * from "./auth/device-token.js";
export * from "./credentials/credential-store.js";
export * from "./executor/executor-manager.js";
export * from "./http/server-client.js";
export * from "./logging.js";
export * from "./pairing/pair-device.js";
export * from "./relay/relay-client.js";
export * from "./runtime.js";

export type AgentCommand =
  | { command: "connect"; serverUrl: URL }
  | { command: "support"; serverUrl: URL; invite: string; acceptSupport?: true };

export function parseAgentCommand(args: string[]): AgentCommand {
  const usage = "Usage: agent connect --server https://remote.example.com OR agent support --server https://remote.example.com --invite TOKEN";
  if (args[0] !== "agent" || args[2] !== "--server" || typeof args[3] !== "string")
    throw new Error(usage);
  const serverUrl = new URL(args[3]);
  if (!["http:", "https:"].includes(serverUrl.protocol)) {
    throw new Error("Server URL must use http or https");
  }
  if (args[1] === "connect" && args.length === 4)
    return { command: "connect", serverUrl };
  const acceptSupport = args.length === 7 && args[6] === "--accept-support";
  if (args[1] === "support" && (args.length === 6 || acceptSupport) &&
      args[4] === "--invite" && /^[A-Za-z0-9_-]{32}$/.test(args[5] ?? "")) {
    if (serverUrl.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(serverUrl.hostname)) {
      throw new Error("Temporary support requires HTTPS");
    }
    return {command:"support", serverUrl, invite: args[5]!, ...(acceptSupport ? {acceptSupport: true as const} : {})};
  }
  throw new Error(usage);
}
