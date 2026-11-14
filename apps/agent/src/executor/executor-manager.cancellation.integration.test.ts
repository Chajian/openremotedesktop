import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopCommanderClient } from "@open-desktop-remote/desktop-commander-adapter";
import { ExecutorManager } from "./executor-manager.js";
import { runAgentConnect } from "../runtime.js";
import { RelayClient, type RelaySocket } from "../relay/relay-client.js";

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };
type Session = {
  child: ChildProcess;
  closed: Promise<void>;
  isClosed: boolean;
  requested: Set<string>;
  events: EventEmitter;
  exit: ChildExit | undefined;
};
const fixture = vi.hoisted(() => ({
  mode: "handshake", sessions: [] as Session[],
  exitBeforeTools: false,
  created: Promise.withResolvers<Session>(),
}));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}) {
    if (!args.includes("--no-onboarding")) return actual.spawn(command, args, options);
    const script = fixture.exitBeforeTools ? "failing-mcp-server.mjs" : "pending-mcp-server.mjs";
    const child = actual.spawn(command, [
      fileURLToPath(new URL(`./fixtures/${script}`, import.meta.url)),
      fixture.exitBeforeTools ? "exit17" : fixture.mode,
    ], options);
    const closed = Promise.withResolvers<void>();
    const session: Session = {
      child, closed: closed.promise, isClosed: false,
      requested: new Set(), events: new EventEmitter(), exit: undefined,
    };
    let diagnostics = "";
    const onData = (data: Buffer) => {
      diagnostics += data.toString("utf8");
      const lines = diagnostics.split("\n");
      diagnostics = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("REQUEST:")) continue;
        const method = line.slice(8);
        session.requested.add(method);
        session.events.emit("request", method);
      }
    };
    child.stderr?.on("data", onData);
    child.once("exit", (code, signal) => {
      session.exit = { code, signal };
      session.events.emit("exit", session.exit);
    });
    child.once("close", () => {
      child.stderr?.off("data", onData);
      session.isClosed = true;
      closed.resolve();
    });
    fixture.sessions.push(session);
    fixture.created.resolve(session);
    return child;
  } };
});

afterEach(async () => {
  for (const session of fixture.sessions.splice(0)) {
    if (!session.isClosed) session.child.kill("SIGKILL");
    await within(session.closed);
  }
  fixture.mode = "handshake";
  fixture.exitBeforeTools = false;
  fixture.created = Promise.withResolvers<Session>();
});

async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Cancellation did not settle before the fixture deadline")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForRequest(method: string, pending: Promise<unknown>): Promise<Session> {
  let timer: NodeJS.Timeout | undefined;
  let detach: () => void = () => {};
  // Startup has its own bounded readiness budget; cancellation still gets 2s.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP fixture ${method} request`)), 5_000);
  });
  const failed = pending.then(() => {
    throw new Error(`MCP startup completed before the ${method} request`);
  }, (error: unknown) => { throw error; });
  try {
    const session = await Promise.race([fixture.created.promise, failed, deadline]);
    const requested = new Promise<void>((resolve, reject) => {
      const onRequest = (received: string) => { if (received === method) resolve(); };
      const onExit = ({ code, signal }: ChildExit) => reject(new Error(
        `MCP fixture exited before ${method} (code: ${code}, signal: ${signal ?? "none"})`,
      ));
      session.events.on("request", onRequest);
      session.events.on("exit", onExit);
      detach = () => {
        session.events.off("request", onRequest);
        session.events.off("exit", onExit);
      };
      if (session.exit) onExit(session.exit);
      else if (session.requested.has(method)) resolve();
    });
    // Both races observe the original startup rejection, including after readiness.
    await Promise.race([requested, failed, deadline]);
    return session;
  } finally {
    clearTimeout(timer);
    detach();
  }
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
  it("preserves the exact startup failure while waiting for a request", async () => {
    const failure = new Error("Fixture startup failed before spawning");
    const manager = new ExecutorManager({ startClient: async () => { throw failure; } });
    const starting = manager.start();
    const outcome = starting.catch((error: unknown) => error);
    try {
      await expect(waitForRequest("initialize", starting)).rejects.toBe(failure);
      expect(fixture.sessions).toHaveLength(0);
    } finally {
      await manager.close();
      await outcome;
    }
  }, 10_000);

  it("reports a real child exit before the tools/list request", async () => {
    fixture.exitBeforeTools = true;
    const { manager, cleanup } = managerFixture();
    const starting = manager.start();
    const outcome = starting.catch((error: unknown) => error);
    try {
      await expect(waitForRequest("tools/list", starting)).rejects.toThrow(
        "MCP fixture exited before tools/list (code: 17, signal: none)",
      );
      const session = fixture.sessions[0]!;
      await within(session.closed);
      expect(session.child.exitCode).toBe(17);
      expect(session.requested.has("initialize")).toBe(true);
      expect(session.requested.has("tools/list")).toBe(false);
      expect(session.isClosed).toBe(true);
      expect(() => process.kill(session.child.pid!, 0)).toThrow();
    } finally {
      await cleanup();
      await outcome;
    }
  }, 10_000);

  it.each(["handshake", "tools"])("closes a real subprocess while %s never replies", async mode => {
    fixture.mode = mode;
    const { manager, cleanup } = managerFixture();
    const starting = manager.start();
    const startOutcome = starting.catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    try {
      const session = await waitForRequest(mode === "handshake" ? "initialize" : "tools/list", starting);
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
      const session = await waitForRequest(mode === "handshake" ? "initialize" : "tools/list", running);
      controller.abort();
      expect(await within(outcome)).toBeUndefined();
      expect(session.isClosed).toBe(true);
      expect(() => process.kill(session.child.pid!, 0)).toThrow();
      expect(manager.state()).toBe("OFFLINE");
      expect(socket.readyState).toBe(3);
      expect(socket.sent.map(raw => JSON.parse(raw).type)).not.toContain("agent.ready");
    } finally {
      controller.abort();
      await cleanup();
      await outcome;
    }
  }, 10_000);
});
