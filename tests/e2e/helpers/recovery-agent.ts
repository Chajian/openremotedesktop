import WebSocket from "ws";
import type { DeviceCredential } from "../../../apps/agent/src/credentials/credential-store.js";
import { ExecutorManager, type ExecutorClient } from "../../../apps/agent/src/executor/executor-manager.js";
import { RelayClient } from "../../../apps/agent/src/relay/relay-client.js";
import { parseRelayMessage, type RelayMessage } from "../../../packages/protocol/src/index.js";

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** A real relay client whose reconnect can be held until a local result is saved. */
export function startRecoveryAgent(
  credential: DeviceCredential,
  startClient: () => Promise<ExecutorClient>,
  options: { stalledOperationTimeoutMs?: number } = {},
) {
  const reconnect = barrier();
  const executor = new ExecutorManager({ startClient });
  const received: RelayMessage[] = [];
  let activeSocket: WebSocket | undefined;
  let connections = 0;
  let failure: unknown;
  const controller = new AbortController();
  const relay = new RelayClient({
    credential,
    executor,
    heartbeatIntervalMs: 250,
    stalledOperationTimeoutMs: options.stalledOperationTimeoutMs,
    socketFactory: async (url, accessToken) => {
      if (connections > 0) await reconnect.promise;
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        socket.once("error", reject);
        socket.on("message", (data) => {
          received.push(parseRelayMessage(JSON.parse(data.toString())));
        });
        socket.once("open", () => {
          activeSocket = socket;
          connections += 1;
          resolve(socket);
        });
      });
    },
  });
  const running = relay.run(controller.signal).catch((error) => { failure = error; });
  return {
    relay,
    received,
    get connections() { return connections; },
    get failure() { return failure; },
    allowReconnect: reconnect.release,
    dropConnection() { activeSocket?.close(4002, "recovery acceptance"); },
    async stop() {
      controller.abort();
      reconnect.release();
      await running;
      await executor.close();
    },
  };
}
