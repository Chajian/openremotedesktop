import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopCommanderClient } from "@open-desktop-remote/desktop-commander-adapter";
import { ExecutorManager } from "./executor-manager.js";
import { runAgentConnect } from "../runtime.js";
import { RelayClient, type RelaySocket } from "../relay/relay-client.js";

type Session = { child: ChildProcess; closed: Promise<void>; isClosed: boolean };
const fixture = vi.hoisted(() => ({
  mode: "handshake", sessions: [] as Session[],
  requested: new Set<string>(),
}));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}) {
    if (!args.includes("--no-onboarding")) return actual.spawn(command, args, options);
    const child = actual.spawn(command, [
      fileURLToPath(new URL("./fixtures/pending-mcp-server.mjs", import.meta.url)), fixture.mode,
    ], options);
    const closed = Promise.withResolvers<void>();
    const session: Session = { child, closed: closed.promise, isClosed: false };
    child.once("close", () => { session.isClosed = true; closed.resolve(); });
    let diagnostics = "";
    child.stderr?.on("data", (data: Buffer) => {
      diagnostics += data.toString("utf8");
      const lines = diagnostics.split("\n");
      diagnostics = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("REQUEST:")) fixture.requested.add(line.slice(8));
    });
    fixture.sessions.push(session);
    return child;
  } };
});

afterEach(async () => {
  for (const session of fixture.sessions.splice(0)) {
    if (!session.isClosed) session.child.kill("SIGKILL");
    await within(session.closed);
  }
  fixture.mode = "handshake";
  fixture.requested.clear();
});

async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cancellation did not settle before the fixture deadline")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function managerFixture() {
  let client: DesktopCommanderClient | undefined;
  const manager = new ExecutorManager({ startClient: (onCreated, signal) => DesktopCommanderClient.start({
    signal,
    onCreated(created) { client = created; onCreated(created); },
  }) });
  return { manager, cleanup: async () => { await client?.close(); await manager.close(); } };
}

class LoopbackSocket extends EventEmitter implements RelaySocket {
  readyState = 1;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}

describe("real MCP initialization cancellation", () => {
  it.each(["handshake", "tools"])("closes a real subprocess while %s never replies", async mode => {
    fixture.mode = mode;
    const { manager, cleanup } = managerFixture();
    const starting = manager.start();
    const startOutcome = starting.catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(fixture.requested.has(mode === "handshake" ? "initialize" : "tools/list")).toBe(true));
      const session = fixture.sessions[0]!;
      const pid = session.child.pid!;
      closing = manager.close();
      await within(closing);
      await within(startOutcome);
      expect(session.isClosed).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(manager.state()).toBe("OFFLINE");
    } finally {
      await cleanup();
      await startOutcome;
      await closing;
    }
  }, 10_000);

  it.each(["handshake", "tools"])("propagates runtime stop through Relay to a pending %s", async mode => {
    fixture.mode = mode;
    const { manager, cleanup } = managerFixture();
    const controller = new AbortController();
    const credential = { serverUrl: "https://remote.example.com/", deviceId: "11111111-1111-4111-8111-111111111111", refreshCredential: "fixture-refresh" };
    const socket = new LoopbackSocket();
    const running = runAgentConnect(new URL(credential.serverUrl), controller.signal, {
      store: { get: async () => credential, set: async () => {}, clear: async () => {} },
      io: { showVerification: () => {} }, ensureCredential: async () => credential,
      createExecutor: () => manager,
      createRelay: () => new RelayClient({
        credential, executor: manager,
        identity: { agentVersion: "fixture-agent", desktopCommanderVersion: "0.3.1", platform: "linux" },
        refreshToken: async () => ({ accessToken: "fixture-access", deviceId: credential.deviceId, expiresAt: Date.now() + 60_000 }),
        socketFactory: async () => socket, heartbeatIntervalMs: 0,
      }),
    });
    const outcome = running.catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(fixture.requested.has(mode === "handshake" ? "initialize" : "tools/list")).toBe(true));
      controller.abort();
      expect(await within(outcome)).toBeUndefined();
      expect(fixture.sessions[0]!.isClosed).toBe(true);
      expect(socket.readyState).toBe(3);
      expect(socket.sent.map(raw => JSON.parse(raw).type)).not.toContain("agent.ready");
    } finally {
      controller.abort();
      await cleanup();
      await outcome;
    }
  }, 10_000);
});
