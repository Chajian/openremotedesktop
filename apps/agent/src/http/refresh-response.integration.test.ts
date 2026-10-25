import { once } from "node:events";
import { inspect } from "node:util";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { DeviceCredentialRejectedError } from "../auth/device-token.js";
import type { CredentialStore, DeviceCredential } from "../credentials/credential-store.js";
import { ExecutorManager } from "../executor/executor-manager.js";
import { RelayClient } from "../relay/relay-client.js";
import { AGENT_RUNTIME_IDENTITY, runAgentConnect } from "../runtime.js";
import { ServerClient } from "./server-client.js";

const deviceId = "11111111-1111-4111-8111-111111111111";
const accessToken = "fixture-private-access";
const token = { accessToken, expiresAt: 123456, deviceId };
type Reply = { status: number; contentType: string; body: string };
const json = (value: unknown, status = 200): Reply => ({
  status, contentType: "application/json", body: JSON.stringify(value),
});

async function runReply(reply: Reply, firstFailure?: "headers" | "body" | "cancel") {
  const controller = new AbortController();
  const paths: string[] = [];
  const retries: number[] = [];
  const messages: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const sockets = new Set<Socket>();
  let starts = 0;
  let closes = 0;
  let clears = 0;
  let pairingPrompts = 0;
  const writes: DeviceCredential[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    request.resume();
    if (paths.length === 1 && firstFailure === "headers") {
      request.socket.destroy();
      return;
    }
    if (paths.length === 1 && (firstFailure === "body" || firstFailure === "cancel")) {
      response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      response.write('{"accessToken":');
      setImmediate(() => firstFailure === "cancel" ? controller.abort() : response.destroy());
      return;
    }
    response.writeHead(reply.status, { "content-type": reply.contentType });
    response.end(reply.body);
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket, request) => {
    authorizations.push(request.headers.authorization);
    socket.on("error", () => undefined);
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as { type: string };
      messages.push(message.type);
      if (message.type === "agent.ready") controller.abort();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  const url = new URL(`http://127.0.0.1:${address.port}/`);
  const credential: DeviceCredential = Object.freeze({
    serverUrl: url.toString(), deviceId, refreshCredential: "fixture-private-refresh",
  });
  let saved: DeviceCredential | null = credential;
  const store: CredentialStore = {
    get: async () => saved,
    set: async next => { saved = next; writes.push(next); },
    clear: async () => { saved = null; clears++; },
  };
  const executor = new ExecutorManager({ startClient: async () => {
    starts++;
    return {
      listTools: async () => [{ name: "read_file" }],
      callTool: async () => ({}),
      close: async () => { closes++; },
    };
  } });
  const running = runAgentConnect(url, controller.signal, {
    store, io: { showVerification() { pairingPrompts++; } },
    createExecutor: () => executor,
    createRelay: (paired, owned) => new RelayClient({
      credential: paired, executor: owned, identity: AGENT_RUNTIME_IDENTITY,
      heartbeatIntervalMs: 0, now: () => 1_000, random: () => 0.5,
      sleep: async ms => {
        retries.push(ms);
        // Bound the old bug's retry loop while allowing a real transport retry.
        if (!firstFailure || retries.length > 1) controller.abort();
      },
    }),
  }).then(() => undefined, (error: unknown) => error);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const failure = await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Refresh runtime did not settle")), 3_000);
      }),
    ]);
    return {
      failure, paths, retries, messages, authorizations, starts, closes,
      saved, credential, writes, clears, pairingPrompts, state: executor.state(),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const socket of ws.clients) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await running;
  }
}

function expectCredentialUnchanged(result: Awaited<ReturnType<typeof runReply>>) {
  expect(result.saved).toBe(result.credential);
  expect(result.saved).toEqual({
    serverUrl: result.credential.serverUrl, deviceId, refreshCredential: "fixture-private-refresh",
  });
  expect(result.writes).toEqual([]);
  expect(result.clears).toBe(0);
  expect(result.pairingPrompts).toBe(0);
}

describe("device refresh response classification with real HTTP and runtime", () => {
  const invalid: [string, Reply][] = [
    ["JSON null", json(null)],
    ["HTML", { status: 200, contentType: "text/html", body: "<html>fixture-private-body</html>" }],
    ["HTML labeled as JSON", { status: 200, contentType: "application/json", body: "<html>fixture-private-body</html>" }],
    ["malformed JSON", { status: 200, contentType: "application/json", body: '{"accessToken":"fixture-private-body"' }],
    ["empty JSON", { status: 200, contentType: "application/json", body: "" }],
    ["array", json([])],
    ["missing accessToken", json({ expiresAt: 123456, deviceId })],
    ["missing expiresAt", json({ accessToken, deviceId })],
    ["missing deviceId", json({ accessToken, expiresAt: 123456 })],
    ["wrong accessToken type", json({ ...token, accessToken: 123 })],
    ["wrong expiresAt type", json({ ...token, expiresAt: "123456" })],
    ["wrong deviceId type", json({ ...token, deviceId: 123 })],
    ["empty accessToken", json({ ...token, accessToken: "" })],
    ["different device identity", json({ ...token, deviceId: "22222222-2222-4222-8222-222222222222" })],
    ["non-finite expiresAt", { status: 200, contentType: "application/json", body: `{"accessToken":"${accessToken}","expiresAt":1e400,"deviceId":"${deviceId}"}` }],
  ];

  it.each(invalid)("rejects %s without retrying, re-pairing or modifying credentials", async (_name, reply) => {
    const result = await runReply(reply);
    expect(result.failure).toMatchObject({ name: "ServerResponseError" });
    expect(result.failure).not.toBeInstanceOf(DeviceCredentialRejectedError);
    const diagnostic = inspect(result.failure, { depth: 5 });
    expect(diagnostic).toMatch(/invalid.*response/i);
    expect(diagnostic).not.toMatch(/pair.*again|fixture-private|<html>|accessToken/);
    expect(result.retries).toEqual([]);
    expect(result.paths).toEqual(["/api/device-auth/refresh"]);
    expect(result.authorizations).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.starts).toBe(0);
    expect(result.state).toBe("OFFLINE");
    expectCredentialUnchanged(result);
  });

  it("accepts the current contract and extra fields without adding token-format or expiry-age rules", async () => {
    const result = await runReply(json({ ...token, futureExtension: true }));
    expect(result.failure).toBeUndefined();
    expect(result.retries).toEqual([]);
    expect(result.paths).toEqual(["/api/device-auth/refresh"]);
    expect(result.authorizations).toEqual([`Bearer ${accessToken}`]);
    expect(result.messages).toContain("agent.ready");
    expect(result.starts).toBe(1);
    expect(result.closes).toBe(1);
    expect(result.state).toBe("OFFLINE");
    expectCredentialUnchanged(result);
  });

  it.each([401, 403])("keeps HTTP %i rejection terminal for JSON, HTML and malformed JSON bodies", async status => {
    for (const reply of [
      json({ error: "INVALID_DEVICE_CREDENTIAL" }, status),
      { status, contentType: "text/html", body: "<html>fixture-private-body</html>" },
      { status, contentType: "application/json", body: '{"error":"fixture-private-body"' },
    ]) {
      const result = await runReply(reply);
      expect(result.failure).toBeInstanceOf(DeviceCredentialRejectedError);
      expect((result.failure as Error).message).toMatch(/pair.*again/i);
      expect(inspect(result.failure, { depth: 5 })).not.toContain("fixture-private");
      expect(result.retries).toEqual([]);
      expect(result.paths).toEqual(["/api/device-auth/refresh"]);
      expect(result.authorizations).toEqual([]);
      expect(result.starts).toBe(0);
      expectCredentialUnchanged(result);
    }
  });

  it.each(["headers", "body"] as const)("retries a real transport failure during %s and then reaches READY", async phase => {
    const result = await runReply(json(token), phase);
    expect(result.failure).toBeUndefined();
    expect(result.retries).toEqual([500]);
    expect(result.paths).toEqual(["/api/device-auth/refresh", "/api/device-auth/refresh"]);
    expect(result.authorizations).toEqual([`Bearer ${accessToken}`]);
    expect(result.messages).toContain("agent.ready");
    expect(result.starts).toBe(1);
    expect(result.closes).toBe(1);
    expectCredentialUnchanged(result);
  });

  it("preserves active cancellation during an incomplete refresh body", async () => {
    const result = await runReply(json(token), "cancel");
    expect(result.failure).toBeUndefined();
    expect(result.retries).toEqual([]);
    expect(result.paths).toEqual(["/api/device-auth/refresh"]);
    expect(result.authorizations).toEqual([]);
    expect(result.starts).toBe(0);
    expect(result.state).toBe("OFFLINE");
    expectCredentialUnchanged(result);
  });

  it("marks fetch TypeErrors as transport failures at the HTTP boundary", async () => {
    const client = new ServerClient(new URL("https://remote.example.com"), async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client.refreshDeviceAccess("fixture-private-refresh")).rejects.toMatchObject({
      name: "ServerTransportError",
    });
  });

  it("keeps a token callback's property-access TypeError terminal", async () => {
    const credential = { serverUrl: "https://remote.example.com/", deviceId, refreshCredential: "fixture-private-refresh" };
    const executor = new ExecutorManager({ startClient: async () => { throw new Error("Unexpected executor start"); } });
    const failure = new TypeError("Cannot read properties of null (reading 'deviceId')");
    const stop = new AbortController();
    const retries: number[] = [];
    let refreshes = 0;
    const relay = new RelayClient({
      credential, executor, identity: AGENT_RUNTIME_IDENTITY,
      refreshToken: async () => { refreshes++; throw failure; },
      sleep: async ms => { retries.push(ms); stop.abort(); },
    });
    try {
      await expect(relay.run(stop.signal)).rejects.toBe(failure);
      expect(refreshes).toBe(1);
      expect(retries).toEqual([]);
    } finally {
      stop.abort();
      await executor.close();
    }
  });
});
