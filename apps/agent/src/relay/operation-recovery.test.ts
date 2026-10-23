import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { OPERATION_RECOVERY_CAPABILITY, OPERATION_RECOVERY_NOTICE, type OperationCallMessage } from "@open-desktop-remote/protocol";
import { ExecutorManager } from "../executor/executor-manager.js";
import { RelayClient, type RelaySocket } from "./relay-client.js";
import { DeviceCredentialRejectedError } from "../auth/device-token.js";
import { ServerRequestError } from "../http/server-client.js";

const deviceId = randomUUID();
const credential = { deviceId, serverUrl: "https://remote.example.com", refreshCredential: "test-only" };
class Socket extends EventEmitter implements RelaySocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  failSend = false;
  send(raw: string) { if (this.failSend) throw new Error("transport closed"); this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}
const notice = { type: "server.notice", protocolVersion: 1, deviceId, level: "info", code: OPERATION_RECOVERY_NOTICE, message: "Recovery enabled" };
async function harness() {
  let effects = 0;
  let finish!: (value: unknown) => void;
  let clientClose!: () => void;
  const executor = new ExecutorManager({ startClient: async () => ({
    listTools: async () => [{ name: "write_file" }],
    callTool: async () => { effects++; return new Promise((resolve) => { finish = resolve; }); },
    close: async () => undefined,
    onClose(handler) { clientClose = handler; },
  }) });
  await executor.start();
  const sockets: Socket[] = [];
  const relay = new RelayClient({ credential, executor, heartbeatIntervalMs: 0,
    now: () => 1_000,
    refreshToken: async () => ({ accessToken: "test-access", expiresAt: 99_000, deviceId }),
    socketFactory: async () => { const socket = new Socket(); sockets.push(socket); return socket; },
  });
  async function connect() {
    const index = sockets.length;
    const pending = relay.connectOnce(new AbortController().signal);
    await vi.waitFor(() => expect(sockets[index]?.sent.some((m) => m.type === "agent.ready")).toBe(true));
    return { socket: sockets[index]!, pending };
  }
  function call(overrides: Partial<OperationCallMessage> = {}): OperationCallMessage {
    return { type: "operation.call", protocolVersion: 1, deviceId, bootId: relay.bootId, requestId: randomUUID(), toolName: "write_file", arguments: { path: "test.txt" }, expiresAt: 61_000, ...overrides };
  }
  return { relay, executor, connect, call, effects: () => effects,
    finish: (value: unknown = { content: [{ type: "text", text: "original completion" }] }) => finish(value),
    crash: () => clientClose() };
}
function query(socket: Socket, call: OperationCallMessage, bootId = call.bootId) {
  socket.receive({ type: "operation.query", protocolVersion: 1, deviceId, bootId, requestId: call.requestId, queryId: randomUUID(), includeResult: true });
}

describe("relay operation recovery", () => {
  it("announces capability but sends no new frame to an old Server and retains legacy dispatch", async () => {
    const h = await harness(); const s = await h.connect();
    expect(s.socket.sent[0]).toMatchObject({ capabilities: expect.arrayContaining([OPERATION_RECOVERY_CAPABILITY]) });
    expect(s.socket.sent.map((m) => m.type)).toEqual(["agent.hello", "agent.ready"]);
    const call = h.call(); const { bootId: _boot, expiresAt: _expires, ...legacy } = call;
    s.socket.receive({ ...legacy, type: "tool.call" });
    await vi.waitFor(() => expect(h.effects()).toBe(1)); h.finish();
    await vi.waitFor(() => expect(s.socket.sent.some((m) => m.type === "tool.result")).toBe(true));
    s.socket.close(); await s.pending;
  });

  it("saves completion across disconnect then queries original result without replay", async () => {
    const h = await harness(); const one = await h.connect(); one.socket.receive(notice);
    expect(one.socket.sent.at(-1)).toMatchObject({ type: "agent.recovery", deviceId, bootId: h.relay.bootId });
    const call = h.call(); one.socket.receive(call); await vi.waitFor(() => expect(h.effects()).toBe(1));
    one.socket.close(); await one.pending; h.finish(); await Promise.resolve(); await Promise.resolve();
    const two = await h.connect(); two.socket.receive(notice); query(two.socket, call);
    expect(two.socket.sent.at(-1)).toMatchObject({ type: "operation.status", snapshot: { state: "completed", outcome: "success", payload: { response: { result: { content: [{ text: "original completion" }] } } } } });
    expect(h.effects()).toBe(1); two.socket.close(); await two.pending;
  });

  it("sends a late saved outcome through the current negotiated session", async () => {
    const h = await harness(); const one = await h.connect(); one.socket.receive(notice);
    const call = h.call(); one.socket.receive(call); await vi.waitFor(() => expect(h.effects()).toBe(1));
    one.socket.close(); await one.pending;
    const two = await h.connect(); two.socket.receive(notice); h.finish();
    await vi.waitFor(() => expect(two.socket.sent.some((m) => m.type === "tool.result" && m.requestId === call.requestId)).toBe(true));
    expect(one.socket.sent.some((m) => m.type === "tool.result")).toBe(false);
    two.socket.close(); await two.pending;
  });

  it("does not deliver recovery completion through a reconnected old Server", async () => {
    const h = await harness(); const one = await h.connect(); one.socket.receive(notice);
    const call = h.call(); one.socket.receive(call); await vi.waitFor(() => expect(h.effects()).toBe(1)); one.socket.close(); await one.pending;
    const two = await h.connect(); h.finish(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(two.socket.sent.map((m) => m.type)).toEqual(["agent.hello", "agent.ready"]);
    two.socket.receive(notice); query(two.socket, call);
    expect(two.socket.sent.at(-1)).toMatchObject({ snapshot: { state: "completed" } });
    two.socket.close(); await two.pending;
  });

  it.each(["operation.call", "operation.query"])("rejects unnegotiated %s and resets negotiation on reconnect", async (type) => {
    const h = await harness(); const one = await h.connect(); one.socket.receive(notice); one.socket.close(); await one.pending;
    const two = await h.connect(); const call = h.call();
    if (type === "operation.call") two.socket.receive(call); else query(two.socket, call);
    expect(two.socket.readyState).toBe(3); expect(h.effects()).toBe(0); await two.pending;
  });

  it.each(["agent.recovery", "operation.status", "tool.result", "agent.ready"])("rejects incoming wrong direction %s", async (type) => {
    const h = await harness(); const s = await h.connect(); s.socket.receive(notice);
    const call = h.call();
    const messages = {
      "agent.recovery": { type, protocolVersion: 1, deviceId, bootId: h.relay.bootId },
      "operation.status": { type, protocolVersion: 1, deviceId, bootId: h.relay.bootId, requestId: call.requestId, queryId: randomUUID(), snapshot: { state: "not_found" } },
      "tool.result": { type, protocolVersion: 1, deviceId, requestId: call.requestId, result: {} },
      "agent.ready": { type, protocolVersion: 1, deviceId, desktopCommanderVersion: "0.2.52", capabilities: [] },
    };
    s.socket.receive(messages[type as keyof typeof messages]);
    expect(s.socket.readyState).toBe(3); expect(h.effects()).toBe(0); await s.pending;
  });

  it("rejects foreign identities and stale socket callbacks without changing the new session", async () => {
    const h = await harness(); const one = await h.connect(); one.socket.receive(notice);
    const stale = one.socket.listeners("message")[0]!; one.socket.close(); await one.pending;
    const two = await h.connect(); two.socket.receive(notice);
    stale(JSON.stringify(h.call())); expect(h.effects()).toBe(0); expect(two.socket.readyState).toBe(1);
    two.socket.receive({ ...notice, deviceId: randomUUID() }); expect(two.socket.readyState).toBe(3); await two.pending;
  });

  it("contains failed result sends and keeps the response queryable", async () => {
    const h = await harness(); const one = await h.connect(); one.socket.receive(notice);
    const call = h.call(); one.socket.receive(call); await vi.waitFor(() => expect(h.effects()).toBe(1));
    one.socket.failSend = true; h.finish(); await new Promise((resolve) => setTimeout(resolve, 0));
    one.socket.failSend = false; query(one.socket, call);
    expect(one.socket.sent.at(-1)).toMatchObject({ snapshot: { state: "completed", outcome: "success" } });
    one.socket.close(); await one.pending;
  });

  it("returns restarted and missing query states without invoking an executor", async () => {
    const h = await harness(); const s = await h.connect(); s.socket.receive(notice); const call = h.call();
    query(s.socket, call); expect(s.socket.sent.at(-1)).toMatchObject({ snapshot: { state: "not_found" } });
    query(s.socket, call, randomUUID()); expect(s.socket.sent.at(-1)).toMatchObject({ snapshot: { state: "restarted" } });
    expect(h.effects()).toBe(0); s.socket.close(); await s.pending;
  });

  it("invalidates running observations when the executor dies without losing cached completions", async () => {
    const h = await harness(); const s = await h.connect(); s.socket.receive(notice);
    const call = h.call(); s.socket.receive(call); await vi.waitFor(() => expect(h.effects()).toBe(1)); h.crash();
    await vi.waitFor(() => expect(s.socket.sent.some((m) => m.type === "tool.error")).toBe(true));
    h.finish(); await Promise.resolve(); await Promise.resolve(); query(s.socket, call);
    expect(s.socket.sent.at(-1)).toMatchObject({ snapshot: { state: "completed", outcome: "unknown" } });
    s.socket.close(); await s.pending;
  });

  it("uses a stable process bootId with an explicit test/runtime override", async () => {
    const h = await harness(); const bootId = randomUUID();
    const options = { credential, executor: h.executor, heartbeatIntervalMs: 0 };
    expect(new RelayClient(options).bootId).toBe(new RelayClient(options).bootId);
    expect(new RelayClient({ ...options, bootId }).bootId).toBe(bootId);
  });
});

it("cleans up a socket closed during executor startup without waiting for a lost close event", async () => {
  const socket = new Socket(); let release!: () => void;
  const executor = new ExecutorManager({ startClient: async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { listTools: async () => [{ name: "read_file" }], callTool: async () => ({}), close: async () => undefined };
  } });
  const relay = new RelayClient({ credential, executor, heartbeatIntervalMs: 0,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 99_000, deviceId }), socketFactory: async () => socket });
  const pending = relay.connectOnce(new AbortController().signal);
  await vi.waitFor(() => expect(executor.state()).toBe("EXECUTOR_STARTING"));
  socket.close(); release();
  await expect(pending).resolves.toBe("reconnect");
  expect(socket.listenerCount("message")).toBe(0);
}, 500);

it("removes listeners when executor startup fails", async () => {
  const socket = new Socket();
  const executor = new ExecutorManager({ startClient: async () => { throw new Error("startup failed"); } });
  const relay = new RelayClient({ credential, executor, heartbeatIntervalMs: 0,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 99_000, deviceId }), socketFactory: async () => socket });
  await expect(relay.connectOnce(new AbortController().signal)).rejects.toThrow("startup failed");
  expect(socket.listenerCount("message")).toBe(0); expect(socket.readyState).toBe(3);
});

it("does not replace a newer session with a stale token refresh", async () => {
  const h = await harness(); const sockets: Socket[] = []; let release!: (token: { accessToken: string; expiresAt: number; deviceId: string }) => void;
  let refreshes = 0;
  const relay = new RelayClient({ credential, executor: h.executor, heartbeatIntervalMs: 0,
    refreshToken: async () => { if (++refreshes === 1) return new Promise((resolve) => { release = resolve; }); return { accessToken: "new", expiresAt: 99_000, deviceId }; },
    socketFactory: async () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  const stale = relay.connectOnce(new AbortController().signal); const current = relay.connectOnce(new AbortController().signal);
  await vi.waitFor(() => expect(sockets[0]?.sent.some((m) => m.type === "agent.ready")).toBe(true));
  release({ accessToken: "old", expiresAt: 99_000, deviceId }); await stale;
  expect(sockets).toHaveLength(1); expect(sockets[0]!.readyState).toBe(1);
  sockets[0]!.close(); await current;
});


it("retains one completed effect across failed refresh and handshake reconnect attempts", async () => {
  const h = await harness(); const stop = new AbortController();
  let refreshes = 0; let connections = 0; let sessions = 0;
  const sockets: Socket[] = []; const sleeps: number[] = [];
  let operation!: OperationCallMessage;
  const relay = new RelayClient({ credential, executor: h.executor, heartbeatIntervalMs: 0, now: () => 1_000, random: () => 0.5,
    refreshToken: async () => { if (++refreshes === 2) throw new TypeError("fetch failed"); return { accessToken: "test", expiresAt: 99_000, deviceId }; },
    socketFactory: async () => { if (++connections === 2) throw Object.assign(new Error("handshake disconnected"), { code: "ECONNRESET" }); const socket = new Socket(); sockets.push(socket); return socket; },
    sleep: async (ms) => { sleeps.push(ms); },
    waitForSocketClose: async (socket) => {
      const current = socket as Socket; current.receive(notice);
      if (++sessions === 1) {
        operation = { ...h.call(), bootId: relay.bootId }; current.receive(operation);
        await vi.waitFor(() => expect(h.effects()).toBe(1)); h.finish();
        await vi.waitFor(() => expect(current.sent.some((m) => m.type === "tool.result")).toBe(true));
      } else {
        query(current, operation);
        expect(current.sent.at(-1)).toMatchObject({ snapshot: { state: "completed", outcome: "success", payload: { status: "available" } } });
        stop.abort();
      }
      current.close();
    },
  });
  await relay.run(stop.signal);
  expect(h.effects()).toBe(1); expect(refreshes).toBe(4); expect(connections).toBe(3); expect(sleeps).toEqual([500, 1_000, 2_000]);
  expect(h.executor.state()).toBe("READY");
});

it.each([new DeviceCredentialRejectedError(), new ServerRequestError(401, null), new ServerRequestError(403, null), new ServerRequestError(400, null)])("keeps rejected credentials and permanent HTTP errors terminal", async (error) => {
  const h = await harness(); let calls = 0;
  const relay = new RelayClient({ credential, executor: h.executor, heartbeatIntervalMs: 0,
    refreshToken: async () => { calls++; throw error; }, sleep: async () => { throw new Error("unexpected retry"); } });
  await expect(relay.run(new AbortController().signal)).rejects.toBe(error); expect(calls).toBe(1);
});

it.each([408, 429, 503])("retries temporary refresh HTTP %s without closing the executor", async (status) => {
  const h = await harness(); const stop = new AbortController(); let calls = 0;
  const relay = new RelayClient({ credential, executor: h.executor, heartbeatIntervalMs: 0,
    refreshToken: async () => { if (++calls === 1) throw new ServerRequestError(status, null); stop.abort(); return { accessToken: "test", expiresAt: 99_000, deviceId }; }, sleep: async () => undefined });
  await relay.run(stop.signal); expect(calls).toBe(2); expect(h.executor.state()).toBe("READY");
});

it("aborts a reconnect backoff promptly", async () => {
  const h = await harness(); const stop = new AbortController(); let calls = 0;
  const relay = new RelayClient({ credential, executor: h.executor, heartbeatIntervalMs: 0,
    refreshToken: async () => { calls++; throw new TypeError("fetch failed"); } });
  const running = relay.run(stop.signal);
  await vi.waitFor(() => expect(calls).toBe(1)); stop.abort(); await running;
  expect(calls).toBe(1);
}, 250);

it("contains an established socket error and preserves running work for the next connection", async () => {
  const h = await harness(); const one = await h.connect(); one.socket.receive(notice);
  const call = h.call(); one.socket.receive(call); await vi.waitFor(() => expect(h.effects()).toBe(1));
  expect(() => one.socket.emit("error", new Error("connection reset"))).not.toThrow();
  await one.pending; h.finish();
  const two = await h.connect(); two.socket.receive(notice); query(two.socket, call);
  expect(two.socket.sent.at(-1)).toMatchObject({ snapshot: { state: "completed", outcome: "success" } });
  expect(h.effects()).toBe(1); two.socket.close(); await two.pending;
});

it("keeps executor startup TypeErrors terminal instead of classifying them as network errors", async () => {
  const socket = new Socket(); const failure = new TypeError("executor initialization failed"); let starts = 0;
  const executor = new ExecutorManager({ startClient: async () => { starts++; throw failure; } });
  const relay = new RelayClient({ credential, executor, heartbeatIntervalMs: 0,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 99_000, deviceId }), socketFactory: async () => socket,
    sleep: async () => { throw new Error("unexpected retry"); } });
  await expect(relay.run(new AbortController().signal)).rejects.toBe(failure); expect(starts).toBe(1);
});

it.each([new Error("factory failed"), new TypeError("invalid socket configuration")])("keeps socket factory programming failures terminal", async (failure) => {
  const h = await harness(); let connections = 0;
  const relay = new RelayClient({ credential, executor: h.executor, heartbeatIntervalMs: 0,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 99_000, deviceId }),
    socketFactory: async () => { connections++; throw failure; },
    sleep: async () => { throw new Error("unexpected retry"); } });
  await expect(relay.run(new AbortController().signal)).rejects.toBe(failure);
  expect(connections).toBe(1);
});

it.each([401, 403, 404])("keeps handshake HTTP %s terminal", async (status) => {
  const h = await harness(); const failure = new ServerRequestError(status, null);
  const relay = new RelayClient({ credential, executor: h.executor, heartbeatIntervalMs: 0,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 99_000, deviceId }),
    socketFactory: async () => { throw failure; },
    sleep: async () => { throw new Error("unexpected retry"); } });
  await expect(relay.run(new AbortController().signal)).rejects.toBe(failure);
});

it.each([new ServerRequestError(408, null), new ServerRequestError(429, null), new ServerRequestError(503, null),
  Object.assign(new Error("network reset"), { code: "ECONNRESET" })])("retries temporary handshake failures", async (failure) => {
  const h = await harness(); const stop = new AbortController(); let connections = 0;
  const relay = new RelayClient({ credential, executor: h.executor, heartbeatIntervalMs: 0,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 99_000, deviceId }),
    socketFactory: async () => {
      if (++connections === 1) throw failure;
      stop.abort(); return new Socket();
    }, sleep: async () => undefined });
  await relay.run(stop.signal);
  expect(connections).toBe(2); expect(h.executor.state()).toBe("READY");
});

it("keeps a malformed 101 handshake from the actual WebSocket factory terminal", async () => {
  const h = await harness(); let attempts = 0;
  const server = createServer();
  server.on("upgrade", (_request, socket) => {
    attempts++;
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP fixture");
    const relay = new RelayClient({
      credential: { ...credential, serverUrl: `http://localhost:${address.port}` },
      executor: h.executor, heartbeatIntervalMs: 0,
      refreshToken: async () => ({ accessToken: "test", expiresAt: 99_000, deviceId }),
      sleep: async () => { throw new Error("unexpected retry"); },
    });
    await expect(relay.run(new AbortController().signal)).rejects.toThrow("Invalid Sec-WebSocket-Accept header");
    expect(attempts).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("retries a network close during the actual WebSocket handshake", async () => {
  const h = await harness(); const stop = new AbortController(); let attempts = 0; let retries = 0;
  const server = createServer();
  server.on("upgrade", (_request, socket) => { attempts++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP fixture");
    const relay = new RelayClient({
      credential: { ...credential, serverUrl: `http://localhost:${address.port}` },
      executor: h.executor, heartbeatIntervalMs: 0,
      refreshToken: async () => ({ accessToken: "test", expiresAt: 99_000, deviceId }),
      sleep: async () => { retries++; stop.abort(); },
    });
    await relay.run(stop.signal);
    expect(attempts).toBe(1); expect(retries).toBe(1); expect(h.executor.state()).toBe("READY");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("restarts a stalled local executor, announces states and keeps old operation unknown without redispatch", async () => {
  let calls = 0;
  let starts = 0;
  const executor = new ExecutorManager({ startClient: async () => {
    starts++;
    return { listTools: async () => [{ name: "write_file" }], close: async () => undefined,
      callTool: async () => { calls++; if (calls === 1) return new Promise(() => undefined); return { content: [{ type: "text", text: "new" }] }; } };
  } });
  await executor.start();
  const socket = new Socket();
  const relay = new RelayClient({ credential, executor, heartbeatIntervalMs: 0,
    stalledOperationTimeoutMs: 20, now: () => 1_000,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 999999, deviceId }),
    socketFactory: async () => socket,
  });
  const pending = relay.connectOnce(new AbortController().signal);
  await vi.waitFor(() => expect(socket.sent.some((m) => m.type === "agent.ready")).toBe(true));
  socket.receive(notice);
  const message = { type: "operation.call" as const, protocolVersion: 1 as const,
    requestId: randomUUID(), deviceId, bootId: relay.bootId, toolName: "write_file", arguments: {}, expiresAt: 61_000 };
  socket.receive(message);
  await vi.waitFor(() => expect(starts).toBe(2), { timeout: 1000 });
  expect(socket.sent.filter((m) => m.type === "agent.executor_status").map((m) => m.state))
    .toEqual(["EXECUTOR_FAILED", "EXECUTOR_STARTING"]);
  const queryId = randomUUID();
  socket.receive({ type: "operation.query", protocolVersion: 1, deviceId, bootId: relay.bootId,
    requestId: message.requestId, queryId, includeResult: true });
  expect(socket.sent.at(-1)).toMatchObject({ type: "operation.status", queryId, snapshot: { state: "completed", outcome: "unknown" } });
  expect(calls).toBe(1);
  socket.close(); await pending;
});

it("keeps Relay non-ready when a stalled executor cannot confirm shutdown", async () => {
  let starts = 0;
  let calls = 0;
  const executor = new ExecutorManager({ startClient: async () => {
    starts++;
    return {
      listTools: async () => [{ name: "write_file" }],
      callTool: async () => { calls++; return new Promise(() => undefined); },
      close: async () => { throw new Error("process may still be alive"); },
    };
  } });
  await executor.start();
  const socket = new Socket();
  const relay = new RelayClient({ credential, executor, heartbeatIntervalMs: 0,
    stalledOperationTimeoutMs: 20, now: () => 1_000,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 999999, deviceId }),
    socketFactory: async () => socket,
  });
  const pending = relay.connectOnce(new AbortController().signal);
  await vi.waitFor(() => expect(socket.sent.some(m => m.type === "agent.ready")).toBe(true));
  socket.receive(notice);
  const requestId = randomUUID();
  socket.receive({ type: "operation.call", protocolVersion: 1, deviceId, bootId: relay.bootId,
    requestId, toolName: "write_file", arguments: {}, expiresAt: 61_000 });
  await vi.waitFor(() => expect(socket.sent.some(m => m.type === "tool.error" && m.requestId === requestId)).toBe(true));
  expect(executor.state()).toBe("EXECUTOR_FAILED");
  expect(starts).toBe(1);
  expect(calls).toBe(1);
  expect(socket.sent.filter(m => m.type === "agent.ready")).toHaveLength(1);
  const states = socket.sent.filter(m => m.type === "agent.executor_status").map(m => m.state);
  expect(states).toContain("EXECUTOR_FAILED");
  expect(states).not.toContain("EXECUTOR_STARTING");
  socket.close(); await pending;
});

it("reports STARTING only after a stalled executor closes, then reports READY", async () => {
  let releaseClose!: () => void;
  let starts = 0;
  const executor = new ExecutorManager({ startClient: async () => {
    starts++;
    return {
      listTools: async () => [{ name: "read_file" }],
      callTool: async () => new Promise(() => undefined),
      close: async () => { if (starts === 1) await new Promise<void>(done => { releaseClose = done; }); },
    };
  } });
  await executor.start();
  const socket = new Socket();
  const relay = new RelayClient({ credential, executor, heartbeatIntervalMs: 0,
    stalledOperationTimeoutMs: 20, now: () => 1_000,
    refreshToken: async () => ({ accessToken: "test", expiresAt: 999999, deviceId }),
    socketFactory: async () => socket,
  });
  const pending = relay.connectOnce(new AbortController().signal);
  await vi.waitFor(() => expect(socket.sent.some(m => m.type === "agent.ready")).toBe(true));
  socket.receive(notice);
  socket.receive({ type: "operation.call", protocolVersion: 1, deviceId, bootId: relay.bootId,
    requestId: randomUUID(), toolName: "read_file", arguments: {}, expiresAt: 61_000 });
  await vi.waitFor(() => expect(socket.sent.some(m =>
    m.type === "agent.executor_status" && m.state === "EXECUTOR_FAILED")).toBe(true));
  const statuses = () => socket.sent.filter(m => m.type === "agent.executor_status").map(m => m.state);
  expect(statuses()).toEqual(["EXECUTOR_FAILED"]);
  expect(starts).toBe(1);
  releaseClose();
  await vi.waitFor(() => expect(starts).toBe(2));
  expect(statuses()).toEqual(["EXECUTOR_FAILED", "EXECUTOR_STARTING"]);
  await vi.waitFor(() => expect(socket.sent.filter(m => m.type === "agent.ready")).toHaveLength(2));
  expect(executor.state()).toBe("READY");
  socket.close(); await pending;
});
