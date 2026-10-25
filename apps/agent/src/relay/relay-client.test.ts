import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DeviceState } from "@open-desktop-remote/shared";
import type { DeviceCredential } from "../credentials/credential-store.js";
import { RelayClient, type RelayClientOptions, type RelaySocket } from "./relay-client.js";
import agentRelease from "../version.json" with { type: "json" };

const identity = { agentVersion: agentRelease.version, desktopCommanderVersion: "0.3.1", platform: "linux" } as const;

const credential: DeviceCredential = {
  serverUrl: "https://remote.example.com/",
  deviceId: "6d1cf056-7fc5-49d4-8930-f989aafd957b",
  refreshCredential: "refresh-secret",
};

class FakeSocket extends EventEmitter implements RelaySocket {
  sent: string[] = [];
  readyState = 1;
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
  terminate() {
    this.close();
  }
}

function fakeExecutor(state: "AUTHENTICATED" | "READY" = "AUTHENTICATED") {
  let current: DeviceState = state;
  return {
    start: vi.fn(async () => {
      current = "READY";
    }),
    restart: vi.fn(async () => {
      current = "READY";
    }),
    state: vi.fn(() => current),
    markIncompatible: vi.fn(() => {
      current = "INCOMPATIBLE";
    }),
    callTool: vi.fn(async (_name: string, _args: unknown, _options?: { timeoutMs: number }): Promise<unknown> => undefined),
    onInvalidated: (_listener: () => void) => () => undefined,
    onStateChanged: (_listener: (state: DeviceState) => void) => () => undefined,
  } satisfies RelayClientOptions["executor"];
}

describe("RelayClient", () => {
  it("removes its close waiter when stop finishes before the socket close event", async () => {
    const socket = new FakeSocket();
    socket.close = () => { socket.readyState = 2; };
    const controller = new AbortController();
    const relay = new RelayClient({
      credential, identity, executor: fakeExecutor("READY"),
      refreshToken: async () => ({ accessToken: "fixture-access", expiresAt: Date.now() + 60_000, deviceId: credential.deviceId }),
      socketFactory: async () => socket, heartbeatIntervalMs: 0,
    });
    const connecting = relay.connectOnce(controller.signal);
    await vi.waitFor(() => expect(socket.sent.some(raw => JSON.parse(raw).type === "agent.ready")).toBe(true));
    controller.abort();
    await connecting;
    expect(socket.listenerCount("close")).toBe(0);
    socket.readyState = 3;
    socket.emit("close");
  });

  it("uses the injected runtime identity in hello and READY without binding to an executor package", async () => {
    const socket = new FakeSocket();
    const relay = new RelayClient({
      credential,
      executor: fakeExecutor("READY"),
      identity: { agentVersion: "fixture-agent", desktopCommanderVersion: "fixture-executor", platform: "darwin", toolsHash: "fixture-catalog" },
      refreshToken: async () => ({ accessToken: "access", expiresAt: Date.now() + 60_000, deviceId: credential.deviceId }),
      socketFactory: async () => socket,
      waitForSocketClose: async () => undefined,
      heartbeatIntervalMs: 0,
    });
    await relay.connectOnce(new AbortController().signal);
    const [hello, ready] = socket.sent.map(value => JSON.parse(value));
    expect(hello).toMatchObject({ agentVersion: "fixture-agent", desktopCommanderVersion: "fixture-executor", platform: "darwin" });
    expect(hello).not.toHaveProperty("toolsHash");
    expect(ready).toMatchObject({ desktopCommanderVersion: "fixture-executor", toolsHash: "fixture-catalog" });
  });

  it("does not announce READY from transport connection alone", async () => {
    const socket = new FakeSocket();
    const executor = fakeExecutor("AUTHENTICATED");
    let release!: () => void;
    const waitForClose = new Promise<void>((resolve) => (release = resolve));

    const relay = new RelayClient({
      identity,
      credential,
      executor,
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "access",
        expiresAt: Date.now() + 60_000,
        deviceId: credential.deviceId,
      }),
      socketFactory: vi.fn().mockResolvedValue(socket),
      waitForSocketClose: vi.fn(async () => waitForClose),
      heartbeatIntervalMs: 60_000,
    });

    const pending = relay.connectOnce(new AbortController().signal);
    await vi.waitFor(() => expect(executor.start).toHaveBeenCalledTimes(1));
    expect(socket.sent.map((value) => JSON.parse(value).type)).toEqual([
      "agent.hello",
      "agent.executor_status",
      "agent.ready",
    ]);
    expect(JSON.parse(socket.sent[0]!).agentVersion).toBe(agentRelease.version);
    release();
    await expect(pending).resolves.toBe("reconnect");
  });

  it("reconnects without restarting a READY executor", async () => {
    const executor = fakeExecutor("READY");
    const sockets = [new FakeSocket(), new FakeSocket()];
    const relay = new RelayClient({
      identity,
      credential,
      executor,
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "access",
        expiresAt: Date.now() + 60_000,
        deviceId: credential.deviceId,
      }),
      socketFactory: vi.fn()
        .mockResolvedValueOnce(sockets[0])
        .mockResolvedValueOnce(sockets[1]),
      waitForSocketClose: vi.fn().mockResolvedValue(undefined),
      heartbeatIntervalMs: 60_000,
    });

    await relay.connectOnce(new AbortController().signal);
    await relay.connectOnce(new AbortController().signal);

    expect(executor.start).not.toHaveBeenCalled();
    expect(
      sockets.map((socket) =>
        socket.sent.map((value) => JSON.parse(value).type),
      ),
    ).toEqual([
      ["agent.hello", "agent.ready"],
      ["agent.hello", "agent.ready"],
    ]);
    for (const socket of sockets) {
      expect(JSON.parse(socket.sent[0]!).agentVersion).toBe(agentRelease.version);
    }
  });

  it("uses bounded exponential reconnect backoff and resets after a stable connection", async () => {
    const executor = fakeExecutor("READY");
    const controller = new AbortController();
    let now = 0;
    let connection = 0;
    const durations = [100, 100, 35_000, 100];
    const sleeps: number[] = [];

    const relay = new RelayClient({
      identity,
      credential,
      executor,
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "access",
        expiresAt: Date.now() + 60_000,
        deviceId: credential.deviceId,
      }),
      socketFactory: vi.fn(async () => new FakeSocket()),
      waitForSocketClose: vi.fn(async () => {
        now += durations[connection++]!;
        if (connection === durations.length) controller.abort();
      }),
      sleep: vi.fn(async (ms: number) => {
        sleeps.push(ms);
      }),
      heartbeatIntervalMs: 0,
      now: () => now,
      random: () => 0.5,
      stableConnectionMs: 30_000,
    });

    await relay.run(controller.signal);

    expect(sleeps).toEqual([500, 1_000, 500]);
    expect(executor.start).not.toHaveBeenCalled();
  });

  it("dispatches server tool.call messages and sends tool.result responses", async () => {
    const socket = new FakeSocket();
    const executor = Object.assign(fakeExecutor("READY"), {
      callTool: vi.fn(async () => ({
        content: [{ type: "text", text: "hello" }],
      })),
    });
    const requestId = "8a4e7a20-8cad-4211-a277-8e0f4438d581";
    const relay = new RelayClient({
      identity,
      credential,
      executor,
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "access",
        expiresAt: Date.now() + 60_000,
        deviceId: credential.deviceId,
      }),
      socketFactory: vi.fn().mockResolvedValue(socket),
      waitForSocketClose: vi.fn(async () => {
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "tool.call",
              protocolVersion: 1,
              requestId,
              deviceId: credential.deviceId,
              toolName: "read_file",
              arguments: { path: "C:/tmp/a.txt" },
            }),
          ),
        );
        await vi.waitFor(() => expect(executor.callTool).toHaveBeenCalledTimes(1));
        await vi.waitFor(() =>
          expect(
            socket.sent.some(
              (raw) =>
                JSON.parse(raw).type === "tool.result" &&
                JSON.parse(raw).requestId === requestId,
            ),
          ).toBe(true),
        );
      }),
      heartbeatIntervalMs: 0,
    });

    await relay.connectOnce(new AbortController().signal);
  });

  it("stops reconnecting after a protocol incompatibility notice", async () => {
    const executor = fakeExecutor("READY");
    const socket = new FakeSocket();
    const relay = new RelayClient({
      identity,
      credential,
      executor,
      refreshToken: vi.fn().mockResolvedValue({
        accessToken: "access",
        expiresAt: Date.now() + 60_000,
        deviceId: credential.deviceId,
      }),
      socketFactory: vi.fn().mockResolvedValue(socket),
      waitForSocketClose: vi.fn(async () => {
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "server.notice",
              protocolVersion: 1,
              level: "error",
              code: "PROTOCOL_INCOMPATIBLE",
              message: "Upgrade required",
            }),
          ),
        );
      }),
      heartbeatIntervalMs: 60_000,
    });

    await expect(
      relay.connectOnce(new AbortController().signal),
    ).resolves.toBe("incompatible");
    expect(executor.markIncompatible).toHaveBeenCalledTimes(1);
  });
});
