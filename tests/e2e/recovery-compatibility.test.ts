import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { ExecutorManager } from "../../apps/agent/src/executor/executor-manager.js";
import { RelayClient } from "../../apps/agent/src/relay/relay-client.js";
import { parseRelayMessage, type RelayMessage } from "../../packages/protocol/src/index.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

// This fixture understands only the original v1 frames and never offers recovery.
// It makes compatibility independent of the newly modified Server implementation.
describe("recovery capability fallback against an old v1 Server", () => {
  for (const agentVersion of ["old", "new"] as const) {
    it(`exchanges only legacy frames with an ${agentVersion} Agent`, async () => {
      const deviceId = randomUUID();
      const requestId = randomUUID();
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      cleanups.push(() => new Promise<void>((resolve, reject) => {
        for (const socket of server.clients) socket.terminate();
        server.close((error) => error ? reject(error) : resolve());
      }));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const received: RelayMessage[] = [];
      const response = new Promise<RelayMessage>((resolve, reject) => {
        server.on("connection", (socket) => {
          socket.on("message", (raw) => {
            const message = parseRelayMessage(JSON.parse(raw.toString()));
            received.push(message);
            if (!["agent.hello", "agent.ready", "agent.executor_status", "heartbeat", "tool.result", "tool.error"].includes(message.type)) {
              reject(new Error(`Old Server cannot parse ${message.type}`));
              return;
            }
            if (message.type === "agent.ready") {
              socket.send(JSON.stringify({
                type: "tool.call", protocolVersion: 1, deviceId, requestId,
                toolName: "get_config", arguments: {},
              }));
            }
            if (message.type === "tool.result" || message.type === "tool.error") resolve(message);
          });
        });
      });
      let effects = 0;
      const result = { content: [{ type: "text", text: "legacy result" }] };
      if (agentVersion === "new") {
        const executor = new ExecutorManager({ startClient: async () => ({
          listTools: async () => [{ name: "get_config" }],
          callTool: async () => { effects += 1; return result; },
          close: async () => undefined,
        }) });
        const relay = new RelayClient({
          credential: { serverUrl: url, deviceId, refreshCredential: "fixture-refresh" },
          executor,
          identity: { agentVersion: "new-fixture", desktopCommanderVersion: "0.3.1", platform: "linux" },
          heartbeatIntervalMs: 0,
          refreshToken: async () => ({ accessToken: "fixture-access", deviceId, expiresAt: Date.now() + 60_000 }),
        });
        const controller = new AbortController();
        const connected = relay.connectOnce(controller.signal);
        cleanups.push(async () => { controller.abort(); await connected; await executor.close(); });
      } else {
        const socket = new WebSocket(`${url.replace("http:", "ws:")}/relay`);
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        cleanups.push(() => socket.terminate());
        socket.on("message", (raw) => {
          const message = parseRelayMessage(JSON.parse(raw.toString()));
          if (message.type !== "tool.call") throw new Error("Unexpected legacy Server message");
          effects += 1;
          socket.send(JSON.stringify({ type: "tool.result", protocolVersion: 1, deviceId, requestId: message.requestId, result }));
        });
        socket.send(JSON.stringify({
          type: "agent.hello", protocolVersion: 1, deviceId, agentVersion: "legacy-fixture",
          protocolRange: { min: 1, max: 1 }, platform: "linux", desktopCommanderVersion: "0.2.52",
          capabilities: ["desktop-commander"],
        }));
        socket.send(JSON.stringify({
          type: "agent.ready", protocolVersion: 1, deviceId, desktopCommanderVersion: "0.2.52",
          capabilities: ["desktop-commander"],
        }));
      }
      expect(await response).toEqual({ type: "tool.result", protocolVersion: 1, deviceId, requestId, result });
      expect(effects).toBe(1);
      expect(received.some((message) => message.type === "agent.hello")).toBe(true);
      expect(received.every((message) => !message.type.startsWith("operation.") && message.type !== "agent.recovery")).toBe(true);
    });
  }
});
