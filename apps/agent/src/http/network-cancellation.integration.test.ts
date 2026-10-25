import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { DeviceCredentialRejectedError, refreshRelayToken } from "../auth/device-token.js";
import type { CredentialStore, DeviceCredential } from "../credentials/credential-store.js";
import { ExecutorManager } from "../executor/executor-manager.js";
import { RelayClient } from "../relay/relay-client.js";
import { pairDevice } from "../pairing/pair-device.js";
import { AGENT_RUNTIME_IDENTITY, runAgentConnect } from "../runtime.js";
import { ServerClient, ServerRequestError } from "./server-client.js";

const deviceId = "11111111-1111-4111-8111-111111111111";
const token = { accessToken: "fixture-access", expiresAt: 123456, deviceId };

async function within<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function loopback(handler: RequestListener) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  return {
    server,
    url: new URL(`http://127.0.0.1:${address.port}/`),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function memoryStore(initial: DeviceCredential | null) {
  let value = initial;
  const writes: DeviceCredential[] = [];
  let clears = 0;
  const store: CredentialStore = {
    get: async () => value,
    set: async next => { value = next; writes.push(next); },
    clear: async () => { value = null; clears++; },
  };
  return { store, writes, get clears() { return clears; } };
}

function localExecutor() {
  let starts = 0;
  let closes = 0;
  const executor = new ExecutorManager({ startClient: async () => {
    starts++;
    return {
      listTools: async () => [{ name: "read_file" }],
      callTool: async () => ({}),
      close: async () => { closes++; },
    };
  } });
  return { executor, get starts() { return starts; }, get closes() { return closes; } };
}

describe("Agent HTTP cancellation with real loopback I/O", () => {
  it("stops runtime during refresh before headers and ignores a late successful response", async () => {
    const requested = Promise.withResolvers<ServerResponse>();
    const disconnected = Promise.withResolvers<void>();
    let requests = 0;
    let upgrades = 0;
    const http = await loopback((request, response) => {
      requests++;
      request.socket.once("close", () => disconnected.resolve());
      requested.resolve(response);
    });
    http.server.on("upgrade", (_request, socket) => { upgrades++; socket.destroy(); });
    const credential = { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" };
    const saved = memoryStore(credential);
    const local = localExecutor();
    const controller = new AbortController();
    const running = runAgentConnect(http.url, controller.signal, {
      store: saved.store, io: { showVerification() {} }, createExecutor: () => local.executor,
    });
    // Observe a rejection immediately so failed assertions cannot leak it.
    const result = running.then(() => undefined, (error: unknown) => error);
    let response: ServerResponse | undefined;
    try {
      response = await within(requested.promise, "refresh request");
      controller.abort();
      expect(await within(result, "runtime stop before server response")).toBeUndefined();
      await within(disconnected.promise, "refresh connection close");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
      expect(requests).toBe(1);
      expect(upgrades).toBe(0);
      expect(local.starts).toBe(0);
      expect(local.executor.state()).toBe("OFFLINE");
      expect(await saved.store.get()).toEqual(credential);
      expect(saved.writes).toEqual([]);
      expect(saved.clears).toBe(0);
    } finally {
      controller.abort();
      response?.end(JSON.stringify(token));
      await http.close();
      await within(result, "runtime test cleanup");
    }
  });

  it.each([200, 401])("aborts a %i refresh after real response headers while its JSON body is incomplete", async status => {
    const headersReceived = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    let response: ServerResponse | undefined;
    const http = await loopback((request, reply) => {
      response = reply;
      request.socket.once("close", () => disconnected.resolve());
      reply.writeHead(status, { "content-type": "application/json" });
      reply.write('{"accessToken":');
    });
    // This observer performs native fetch; no response or network is mocked.
    const observedFetch: typeof fetch = async (input, init) => {
      const received = await fetch(input, init);
      headersReceived.resolve();
      return received;
    };
    const client = new ServerClient(http.url, observedFetch);
    const controller = new AbortController();
    const credential = { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" };
    const refreshed = refreshRelayToken(credential, client, controller.signal);
    const result = refreshed.then(value => value, (error: unknown) => error);
    try {
      await within(headersReceived.promise, "native fetch response headers");
      controller.abort();
      const failure = await within(result, "response body cancellation");
      expect(failure).toBe(controller.signal.reason);
      expect(failure).not.toBeInstanceOf(DeviceCredentialRejectedError);
      await within(disconnected.promise, "incomplete response connection close");
    } finally {
      controller.abort();
      response?.end('"late-access","expiresAt":123456,"deviceId":"11111111-1111-4111-8111-111111111111"}');
      await http.close();
      await within(result, "body test cleanup");
    }
  });

  it("does no HTTP work or executor startup for a pre-aborted relay connection", async () => {
    let requests = 0;
    const http = await loopback((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
    });
    const local = localExecutor();
    const controller = new AbortController();
    controller.abort();
    try {
      const relay = new RelayClient({
        credential: { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" },
        executor: local.executor, identity: AGENT_RUNTIME_IDENTITY,
      });
      await within(relay.connectOnce(controller.signal), "pre-aborted relay");
      expect(requests).toBe(0);
      expect(local.starts).toBe(0);
    } finally {
      await local.executor.close();
      await http.close();
    }
  });

  it("preserves a normal refresh, runtime identity, READY, and clean shutdown", async () => {
    const requests: string[] = [];
    const http = await loopback((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
    });
    const ws = new WebSocketServer({ server: http.server });
    const ready = Promise.withResolvers<void>();
    const messages: Array<Record<string, unknown>> = [];
    ws.on("connection", socket => socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "agent.ready") ready.resolve();
    }));
    const credential = { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" };
    const saved = memoryStore(credential);
    const local = localExecutor();
    const controller = new AbortController();
    const running = runAgentConnect(http.url, controller.signal, {
      store: saved.store, io: { showVerification() {} }, createExecutor: () => local.executor,
    });
    const result = running.then(() => undefined, (error: unknown) => error);
    try {
      await within(ready.promise, "agent READY");
      controller.abort();
      expect(await within(result, "normal runtime shutdown")).toBeUndefined();
      expect(requests).toEqual(["/api/device-auth/refresh"]);
      expect(messages[0]).toMatchObject({
        type: "agent.hello", agentVersion: AGENT_RUNTIME_IDENTITY.agentVersion,
        desktopCommanderVersion: AGENT_RUNTIME_IDENTITY.desktopCommanderVersion,
        platform: AGENT_RUNTIME_IDENTITY.platform,
      });
      expect(messages[0]).not.toHaveProperty("toolsHash");
      expect(messages.find(message => message.type === "agent.ready")).toMatchObject({
        desktopCommanderVersion: AGENT_RUNTIME_IDENTITY.desktopCommanderVersion,
        toolsHash: AGENT_RUNTIME_IDENTITY.toolsHash,
      });
      expect(local.starts).toBe(1);
      expect(local.closes).toBe(1);
      expect(await saved.store.get()).toEqual(credential);
    } finally {
      controller.abort();
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await http.close();
      await within(result, "success test cleanup");
    }
  });

  it.each(["create", "poll"])("stops first pairing during %s without saving a late approval or creating an executor", async stage => {
    const requested = Promise.withResolvers<ServerResponse>();
    const disconnected = Promise.withResolvers<void>();
    const paths: string[] = [];
    const http = await loopback((request, response) => {
      paths.push(request.url ?? "");
      if (stage === "poll" && request.url === "/api/device-pairings") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          deviceCode: "fixture-code", userCode: "ABCD-2345",
          verificationUri: "https://remote.example.com/device", expiresIn: 600, interval: 60,
        }));
      } else {
        request.socket.once("close", () => disconnected.resolve());
        requested.resolve(response);
      }
    });
    const existing = { serverUrl: "https://other.example.com/", deviceId, refreshCredential: "fixture-existing" };
    const saved = memoryStore(existing);
    const controller = new AbortController();
    const local = localExecutor();
    let createdExecutors = 0;
    const result = runAgentConnect(http.url, controller.signal, {
      store: saved.store, io: { showVerification() {} },
      createExecutor: () => { createdExecutors++; return local.executor; },
    }).then(() => undefined, (error: unknown) => error);
    let response: ServerResponse | undefined;
    try {
      response = await within(requested.promise, "pairing request");
      controller.abort();
      expect(await within(result, "runtime pairing cancellation")).toBeUndefined();
      await within(disconnected.promise, "pairing connection close");
      response.end(JSON.stringify({ status: "approved", deviceId, refreshCredential: "fixture-late" }));
      expect(paths).toHaveLength(stage === "create" ? 1 : 2);
      expect(createdExecutors).toBe(0);
      expect(saved.writes).toEqual([]);
      expect(saved.clears).toBe(0);
      expect(await saved.store.get()).toEqual(existing);
    } finally {
      controller.abort();
      response?.end();
      await http.close();
      await within(result, "pairing test cleanup");
    }
  });

  it("cancels its real pairing interval timer without issuing another poll", async () => {
    const timerStarted = Promise.withResolvers<ReturnType<typeof setTimeout>>();
    const originalSetTimeout = globalThis.setTimeout;
    let releaseTimer: (() => void) | undefined;
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args);
      if (args[1] === 60_000) {
        timerStarted.resolve(timer);
        const [callback, , ...values] = args;
        releaseTimer = () => callback(...values);
      }
      return timer;
    }) as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const paths: string[] = [];
    const http = await loopback((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/api/device-pairings" ? {
        deviceCode: "fixture-code", userCode: "ABCD-2345",
        verificationUri: "https://remote.example.com/device", expiresIn: 600, interval: 60,
      } : { status: "pending", interval: 60 }));
    });
    const controller = new AbortController();
    const result = pairDevice(http.url, { showVerification() {} }, { signal: controller.signal })
      .then(value => value, (error: unknown) => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = await within(timerStarted.promise, "pairing interval timer");
      controller.abort();
      expect(await within(result, "pairing interval cancellation")).toBe(controller.signal.reason);
      expect(clear).toHaveBeenCalledWith(timer);
      expect(paths).toEqual(["/api/device-pairings", "/api/device-pairings/poll?device_code=fixture-code"]);
    } finally {
      controller.abort();
      clearTimeout(timer);
      timeout.mockRestore();
      clear.mockRestore();
      await http.close();
      releaseTimer?.();
      await within(result, "pairing timer test cleanup");
    }
  });

  it("does not create or poll a pairing when its signal was already aborted", async () => {
    let requests = 0;
    const http = await loopback((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "expired" }));
    });
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await pairDevice(http.url, { showVerification() {} }, { signal: controller.signal })
        .catch((error: unknown) => error);
      expect(result).toBe(controller.signal.reason);
      expect(requests).toBe(0);
    } finally {
      await http.close();
    }
  });
});

describe("Agent WebSocket cancellation with real loopback I/O", () => {
  it("closes a hanging upgrade request on runtime stop without starting an executor or retrying", async () => {
    const upgraded = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    let requests = 0;
    let upgrades = 0;
    const http = await loopback((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
    });
    http.server.on("upgrade", (_request, socket) => {
      upgrades++;
      socket.on("end", () => socket.end());
      socket.resume();
      socket.once("close", () => disconnected.resolve());
      upgraded.resolve();
    });
    const credential = { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" };
    const saved = memoryStore(credential);
    const local = localExecutor();
    const controller = new AbortController();
    const result = runAgentConnect(http.url, controller.signal, {
      store: saved.store, io: { showVerification() {} }, createExecutor: () => local.executor,
    }).then(() => undefined, (error: unknown) => error);
    try {
      await within(upgraded.promise, "upgrade request");
      controller.abort();
      expect(await within(result, "hanging handshake cancellation")).toBeUndefined();
      await within(disconnected.promise, "hanging handshake socket close");
      expect(requests).toBe(1);
      expect(upgrades).toBe(1);
      expect(local.starts).toBe(0);
      expect(saved.writes).toEqual([]);
      expect(saved.clears).toBe(0);
    } finally {
      controller.abort();
      await http.close();
      await within(result, "handshake test cleanup");
    }
  });

  it.each(["default", "legacy"])("physically closes a peer that never answers the close frame with a %s waiter", async waiter => {
    const receivedFrame = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const legacyWait = Promise.withResolvers<void>();
    const http = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
    });
    http.server.on("upgrade", (request, socket) => {
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("data", () => receivedFrame.resolve());
      socket.on("end", () => socket.end());
      socket.once("close", () => disconnected.resolve());
    });
    const local = localExecutor();
    const controller = new AbortController();
    const saved = memoryStore({ serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" });
    const result = runAgentConnect(http.url, controller.signal, {
      store: saved.store, io: { showVerification() {} }, createExecutor: () => local.executor,
      createRelay: (credential, executor) => new RelayClient({
        credential, executor, identity: AGENT_RUNTIME_IDENTITY,
        ...(waiter === "legacy" ? { waitForSocketClose: async () => legacyWait.promise } : {}),
      }),
    }).then(() => undefined, (error: unknown) => error);
    try {
      await within(receivedFrame.promise, "established WebSocket frame");
      controller.abort();
      expect(await within(result, "established runtime stop")).toBeUndefined();
      await within(disconnected.promise, "noncooperating peer TCP close");
      expect(local.starts).toBe(1);
      expect(local.closes).toBe(1);
    } finally {
      controller.abort();
      legacyWait.resolve();
      await http.close();
      await within(result, "established test cleanup");
    }
  });

  it("closes its established socket while executor startup is still pending", async () => {
    const startup = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const http = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
    });
    const ws = new WebSocketServer({ server: http.server });
    ws.on("connection", socket => socket.once("close", () => disconnected.resolve()));
    const executor = new ExecutorManager({ startClient: async onCreated => {
      const client = {
        listTools: async () => new Promise<never>(() => undefined),
        callTool: async () => ({}), close: async () => undefined,
      };
      onCreated(client);
      startup.resolve();
      return client;
    } });
    const controller = new AbortController();
    const relay = new RelayClient({
      credential: { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" },
      executor, identity: AGENT_RUNTIME_IDENTITY, heartbeatIntervalMs: 0,
    });
    const result = relay.run(controller.signal).then(() => undefined, (error: unknown) => error);
    try {
      await within(startup.promise, "pending executor startup");
      controller.abort();
      await within(disconnected.promise, "socket close before startup settles");
      await executor.close();
      expect(await within(result, "stopped startup unwinding")).toBeUndefined();
    } finally {
      controller.abort();
      await executor.close();
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await http.close();
      await within(result, "startup test cleanup");
    }
  });

  it("terminates a late socket returned by a legacy factory after stop", async () => {
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const http = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
    });
    http.server.on("upgrade", (request, socket) => {
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.resume();
      socket.on("end", () => socket.end());
      socket.once("close", () => disconnected.resolve());
    });
    const local = localExecutor();
    const controller = new AbortController();
    let ownedSocket: WebSocket | undefined;
    const relay = new RelayClient({
      credential: { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" },
      executor: local.executor, identity: AGENT_RUNTIME_IDENTITY, heartbeatIntervalMs: 0,
      socketFactory: async (url, accessToken) => {
        const socket = new WebSocket(url, { headers: { authorization: `Bearer ${accessToken}` } });
        ownedSocket = socket;
        await once(socket, "open");
        opened.resolve();
        await release.promise;
        return socket;
      },
    });
    const result = relay.run(controller.signal).then(() => undefined, (error: unknown) => error);
    try {
      await within(opened.promise, "legacy factory socket");
      controller.abort();
      release.resolve();
      expect(await within(result, "late factory cancellation")).toBeUndefined();
      await within(disconnected.promise, "late socket physical close");
      expect(ownedSocket?.readyState).toBe(WebSocket.CLOSED);
      expect(ownedSocket?.listenerCount("error")).toBe(0);
      expect(ownedSocket?.listenerCount("close")).toBe(0);
      expect(local.starts).toBe(0);
    } finally {
      controller.abort();
      release.resolve();
      ownedSocket?.terminate();
      await local.executor.close();
      await http.close();
      await within(result, "late socket test cleanup");
    }
  });

  it.each([403, 503])("preserves HTTP %i handshake classification while termination emits its error", async status => {
    const disconnected = Promise.withResolvers<void>();
    let upgrades = 0;
    let retries = 0;
    const http = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
    });
    http.server.on("upgrade", (_request, socket) => {
      upgrades++;
      socket.on("end", () => socket.end());
      socket.resume();
      socket.once("close", () => disconnected.resolve());
      socket.write(`HTTP/1.1 ${status} Rejected\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\npartial body`);
    });
    const controller = new AbortController();
    const local = localExecutor();
    const relay = new RelayClient({
      credential: { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" },
      executor: local.executor, identity: AGENT_RUNTIME_IDENTITY, heartbeatIntervalMs: 0,
      sleep: async () => { retries++; controller.abort(); },
    });
    const result = relay.run(controller.signal).then(() => undefined, (error: unknown) => error);
    try {
      const failure = await within(result, "rejected handshake cleanup");
      if (status === 403) {
        expect(failure).toBeInstanceOf(ServerRequestError);
        expect(failure).toMatchObject({ status: 403 });
        expect(retries).toBe(0);
      } else {
        expect(failure).toBeUndefined();
        expect(retries).toBe(1);
      }
      await within(disconnected.promise, "rejected handshake TCP close");
      expect(upgrades).toBe(1);
      expect(local.starts).toBe(0);
    } finally {
      controller.abort();
      await local.executor.close();
      await http.close();
      await within(result, "rejection test cleanup");
    }
  });

  it("preserves an unrelated startup failure even when stop happens before its rejection is observed", async () => {
    const http = await loopback((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(token));
    });
    const ws = new WebSocketServer({ server: http.server });
    const controller = new AbortController();
    const failure = new Error("fixture startup failure");
    const executor = new ExecutorManager({ startClient: async () => {
      controller.abort();
      throw failure;
    } });
    const relay = new RelayClient({
      credential: { serverUrl: http.url.toString(), deviceId, refreshCredential: "fixture-refresh" },
      executor, identity: AGENT_RUNTIME_IDENTITY, heartbeatIntervalMs: 0,
    });
    const result = relay.run(controller.signal).then(() => undefined, (error: unknown) => error);
    try {
      expect(await within(result, "startup failure")).toBe(failure);
    } finally {
      controller.abort();
      await executor.close();
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await http.close();
      await within(result, "startup failure test cleanup");
    }
  });
});
