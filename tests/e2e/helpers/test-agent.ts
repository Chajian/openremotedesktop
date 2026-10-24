import WebSocket from "ws";
import { DesktopCommanderClient } from "../../../packages/desktop-commander-adapter/src/desktop-commander-client.js";
import { ExecutorManager } from "../../../apps/agent/src/executor/executor-manager.js";
import { RelayClient } from "../../../apps/agent/src/relay/relay-client.js";
import { refreshRelayToken } from "../../../apps/agent/src/auth/device-token.js";
import type { DeviceCredential } from "../../../apps/agent/src/credentials/credential-store.js";
import {
  PROTOCOL_VERSION,
  parseRelayMessage,
  type RelayMessage,
} from "../../../packages/protocol/src/index.js";

function relayUrl(serverUrl: string): URL {
  const url = new URL("/relay", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export async function startRealAgent(
  credential: DeviceCredential,
  cwd: string,
) {
  const executor = new ExecutorManager({
    startClient: () => DesktopCommanderClient.start({ cwd }),
  });
  let activeSocket: WebSocket | null = null;
  const relay = new RelayClient({
    credential,
    executor,
    heartbeatIntervalMs: 250,
    stableConnectionMs: 1_000,
    socketFactory: async (url, accessToken) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        socket.once("error", reject);
        socket.once("open", () => {
          activeSocket = socket;
          resolve(socket);
        });
      }),
  });
  const controller = new AbortController();
  let failure: unknown;
  const runPromise = relay.run(controller.signal).catch((error) => {
    failure = error;
  });

  return {
    executor,
    relay,
    controller,
    get failure() {
      return failure;
    },
    dropConnection() {
      activeSocket?.close(4002, "e2e forced reconnect");
    },
    async stop() {
      controller.abort();
      await Promise.race([
        runPromise,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      await executor.close().catch(() => undefined);
      if (failure && !controller.signal.aborted) throw failure;
    },
  };
}

export async function startFakeAgent(
  credential: DeviceCredential,
  label: string,
  options: {
    disconnectOnFirstCall?: boolean;
    responseDelayMs?: number;
  } = {},
) {
  const token = await refreshRelayToken(credential);
  const socket = new WebSocket(relayUrl(credential.serverUrl), {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  let callCount = 0;
  let firstRequestId: string | null = null;
  let closed = false;

  function send(message: RelayMessage) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  socket.on("message", (raw) => {
    const message = parseRelayMessage(JSON.parse(raw.toString()));
    if (message.type !== "tool.call") return;
    callCount += 1;
    firstRequestId ??= message.requestId;

    if (options.disconnectOnFirstCall && callCount === 1) {
      socket.close(4000, "intentional ambiguous disconnect");
      return;
    }

    setTimeout(() => {
      send({
        type: "tool.result",
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
        deviceId: credential.deviceId,
        result: {
          content: [
            {
              type: "text",
              text: `${label}:${message.toolName}`,
            },
          ],
          structuredContent: {
            label,
            toolName: message.toolName,
            arguments: message.arguments,
          },
        },
      });
    }, options.responseDelayMs ?? 0);
  });

  send({
    type: "agent.hello",
    protocolVersion: PROTOCOL_VERSION,
    deviceId: credential.deviceId,
    agentVersion: "e2e-fake",
    protocolRange: { min: 1, max: 1 },
    platform: "linux",
    desktopCommanderVersion: "0.3.1",
    capabilities: ["desktop-commander"],
  });
  send({
    type: "agent.executor_status",
    protocolVersion: PROTOCOL_VERSION,
    deviceId: credential.deviceId,
    state: "EXECUTOR_STARTING",
  });
  send({
    type: "agent.ready",
    protocolVersion: PROTOCOL_VERSION,
    deviceId: credential.deviceId,
    desktopCommanderVersion: "0.3.1",
    capabilities: ["desktop-commander"],
  });

  const heartbeat = setInterval(() => {
    send({
      type: "heartbeat",
      protocolVersion: PROTOCOL_VERSION,
      deviceId: credential.deviceId,
      timestamp: Date.now(),
    });
  }, 250);
  heartbeat.unref();

  socket.once("close", () => {
    closed = true;
    clearInterval(heartbeat);
  });

  return {
    socket,
    get callCount() {
      return callCount;
    },
    get firstRequestId() {
      return firstRequestId;
    },
    get closed() {
      return closed;
    },
    async stop() {
      clearInterval(heartbeat);
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close(1000, "test cleanup");
      });
    },
  };
}
