import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolResultMessage } from "@open-desktop-remote/protocol";
import type { WebSocket } from "ws";
import { ConnectionRegistry } from "./connection-registry.js";
import { RelayRequestError, RequestBroker } from "./request-broker.js";

const deviceId = "6d1cf056-7fc5-49d4-8930-f989aafd957b";

class FakeSocket {
  sent: string[] = [];
  close() {}
  terminate() {}
  send(value: string) {
    this.sent.push(value);
  }
}

function readyFixture() {
  const registry = new ConnectionRegistry();
  const socket = new FakeSocket();
  registry.attach(deviceId, socket as unknown as WebSocket);
  registry.markAuthenticated(deviceId, socket as unknown as WebSocket);
  registry.markExecutorState(deviceId, socket as unknown as WebSocket, "EXECUTOR_STARTING");
  registry.markExecutorState(deviceId, socket as unknown as WebSocket, "READY");
  return { registry, socket };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof RelayRequestError ? error.code : undefined;
}

describe("RequestBroker", () => {
  it("rejects calls before dispatch when a device is offline or not READY", async () => {
    const offline = new RequestBroker(new ConnectionRegistry());
    await expect(
      offline.call(deviceId, "read_file", {}, { timeoutMs: 50 }),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === "DEVICE_OFFLINE");

    const registry = new ConnectionRegistry();
    const socket = new FakeSocket();
    registry.attach(deviceId, socket as unknown as WebSocket);
    registry.markAuthenticated(deviceId, socket as unknown as WebSocket);
    const notReady = new RequestBroker(registry);
    await expect(
      notReady.call(deviceId, "read_file", {}, { timeoutMs: 50 }),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === "DEVICE_NOT_READY");
    expect(socket.sent).toHaveLength(0);
  });

  it("resolves a dispatched request from a matching tool.result", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const pending = broker.call(deviceId, "read_file", { path: "a" }, { timeoutMs: 200 });
    const sent = JSON.parse(socket.sent[0]!) as { requestId: string };

    const result: ToolResultMessage = {
      type: "tool.result",
      protocolVersion: 1,
      requestId: sent.requestId,
      deviceId,
      result: { content: [] },
    };
    broker.handleMessage(result);

    await expect(pending).resolves.toEqual(result);
  });

  it("marks a dispatched call EXECUTION_UNKNOWN when its socket disconnects and never replays it", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const pending = broker.call(deviceId, "write_file", { path: "a" }, { timeoutMs: 200 });
    expect(socket.sent).toHaveLength(1);

    broker.handleDisconnect(deviceId, socket as unknown as WebSocket);
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "EXECUTION_UNKNOWN",
    );

    const replacement = new FakeSocket();
    registry.attach(deviceId, replacement as unknown as WebSocket);
    registry.markAuthenticated(deviceId, replacement as unknown as WebSocket);
    expect(replacement.sent).toHaveLength(0);
  });

  it("sends tool.cancel and rejects the upstream request as REQUEST_CANCELLED", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const pending = broker.call(deviceId, "read_file", {}, { timeoutMs: 200 });
    const requestId = (JSON.parse(socket.sent[0]!) as { requestId: string }).requestId;

    broker.cancel(requestId);

    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: "tool.cancel",
      requestId,
      deviceId,
    });
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "REQUEST_CANCELLED",
    );
  });

  it("returns REQUEST_TIMEOUT without replay and ignores a late result", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const pending = broker.call(deviceId, "read_file", {}, { timeoutMs: 5 });
    const requestId = (JSON.parse(socket.sent[0]!) as { requestId: string }).requestId;

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "REQUEST_TIMEOUT",
    );

    expect(() =>
      broker.handleMessage({
        type: "tool.result",
        protocolVersion: 1,
        requestId,
        deviceId,
        result: { content: [{ type: "text", text: "late" }] },
      }),
    ).not.toThrow();
    expect(socket.sent).toHaveLength(1);
  });

  it("uses distinct request ids for concurrent calls", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const first = broker.call(deviceId, "read_file", {}, { timeoutMs: 200 });
    const second = broker.call(deviceId, "read_file", {}, { timeoutMs: 200 });
    const [a, b] = socket.sent
      .slice(0, 2)
      .map((raw) => JSON.parse(raw) as { requestId: string });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.requestId).not.toBe(b!.requestId);

    broker.cancel(a!.requestId);
    broker.cancel(b!.requestId);
    await Promise.allSettled([first, second]);
  });
});
