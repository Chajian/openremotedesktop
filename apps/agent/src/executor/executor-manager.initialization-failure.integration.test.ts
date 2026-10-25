import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkErrorCode } from "@modelcontextprotocol/client";
import { DesktopCommanderClient } from "@open-desktop-remote/desktop-commander-adapter";
import { ExecutorManager } from "./executor-manager.js";
import { runAgentConnect } from "../runtime.js";
import { RelayClient, type RelaySocket } from "../relay/relay-client.js";

type Session = {
  child: ChildProcess;
  closed: Promise<void>;
  initialized: Promise<void>;
  isClosed: boolean;
  events: string[];
};
const fixture = vi.hoisted(() => ({
  mode: "exit17", sessions: [] as Session[],
  created: Promise.withResolvers<Session>(),
}));

// Only replace the executable arguments; Adapter, SDK, process ownership,
// stdio framing, shutdown and runtime/Relay code remain real.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}) {
    if (!args.includes("--no-onboarding")) return actual.spawn(command, args, options);
    const child = actual.spawn(command, [
      fileURLToPath(new URL("./fixtures/failing-mcp-server.mjs", import.meta.url)), fixture.mode,
    ], options);
    const closed = Promise.withResolvers<void>();
    const initialized = Promise.withResolvers<void>();
    const session: Session = { child, closed: closed.promise, initialized: initialized.promise, isClosed: false, events: [] };
    child.once("close", () => { session.isClosed = true; closed.resolve(); });
    let diagnostics = "";
    child.stderr?.on("data", (data: Buffer) => {
      diagnostics += data.toString("utf8");
      const lines = diagnostics.split("\n");
      diagnostics = lines.pop() ?? "";
      for (const line of lines) {
        session.events.push(line);
        if (line === "REQUEST:initialize") initialized.resolve();
      }
    });
    fixture.sessions.push(session);
    fixture.created.resolve(session);
    return child;
  } };
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of fixture.sessions.splice(0)) {
    if (!session.isClosed) session.child.kill("SIGKILL");
    await within(session.closed);
  }
  fixture.mode = "exit17";
  fixture.created = Promise.withResolvers<Session>();
});

async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Initialization failure did not settle before the fixture deadline")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function managerFixture() {
  const states: string[] = [];
  const manager = new ExecutorManager({
    onState: state => states.push(state),
    startClient: (onCreated, signal) => DesktopCommanderClient.start({ onCreated, signal }),
  });
  return { manager, states };
}

class ControlledSocket extends EventEmitter implements RelaySocket {
  readyState = 1;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}

const failureCases = [
  { mode: "exit17", code: SdkErrorCode.ConnectionClosed, exitCode: 17 },
  { mode: "refuse", code: -32603, exitCode: 0 },
];

describe("real MCP initialization failure attribution", () => {
  it.each(failureCases)("rejects startup after $mode and confirms the owned child closes", async ({ mode, code, exitCode }) => {
    fixture.mode = mode;
    const { manager, states } = managerFixture();
    const outcome = manager.start().then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    try {
      const session = await within(fixture.created.promise);
      await within(session.initialized);
      const { error } = await within(outcome);
      expect(error).toMatchObject({ code });
      if (mode === "refuse") expect(error).toMatchObject({ message: expect.stringContaining("Fixture initialization refused") });
      expect(session.isClosed).toBe(true);
      expect(session.child.exitCode).toBe(exitCode);
      expect(session.child.stdout?.destroyed).toBe(true);
      expect(session.child.stderr?.destroyed).toBe(true);
      if (mode === "refuse") expect(session.events).toContain("EVENT:stdin-ended");
      expect(() => process.kill(session.child.pid!, 0)).toThrow();
      expect(states).toEqual(["EXECUTOR_STARTING", "EXECUTOR_FAILED"]);
      await expect(manager.callTool("write_file", {})).rejects.toThrow(/not READY/);
      expect(fixture.sessions).toHaveLength(1);
    } finally {
      await manager.close();
      await outcome;
    }
  }, 10_000);

  it.each(failureCases)("terminates runtime after $mode without heartbeat or reconnect", async ({ mode, code }) => {
    fixture.mode = mode;
    const { manager } = managerFixture();
    const controller = new AbortController();
    const socket = new ControlledSocket();
    const credential = { serverUrl: "https://remote.example.com/", deviceId: "11111111-1111-4111-8111-111111111111", refreshCredential: "fixture-refresh" };
    const intervals = vi.spyOn(globalThis, "setInterval");
    let refreshes = 0;
    let connections = 0;
    let retries = 0;
    const running = runAgentConnect(new URL(credential.serverUrl), controller.signal, {
      store: { get: async () => credential, set: async () => {}, clear: async () => {} },
      io: { showVerification: () => {} }, ensureCredential: async () => credential,
      createExecutor: () => manager,
      createRelay: () => new RelayClient({
        credential, executor: manager,
        identity: { agentVersion: "fixture-agent", desktopCommanderVersion: "0.3.1", platform: "linux" },
        refreshToken: async () => { refreshes++; return { accessToken: "fixture-access", deviceId: credential.deviceId, expiresAt: Date.now() + 60_000 }; },
        socketFactory: async () => { connections++; return socket; },
        sleep: async () => { retries++; throw new Error("Unexpected retry after executor startup failure"); },
        heartbeatIntervalMs: 12_345,
      }),
    });
    const outcome = running.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    try {
      const session = await within(fixture.created.promise);
      await within(session.initialized);
      const { error } = await within(outcome);
      expect(error).toMatchObject({ code });
      if (mode === "refuse") expect(error).toMatchObject({ message: expect.stringContaining("Fixture initialization refused") });
      expect(controller.signal.aborted).toBe(false);
      expect(session.isClosed).toBe(true);
      expect(session.child.stdout?.destroyed).toBe(true);
      expect(session.child.stderr?.destroyed).toBe(true);
      expect(manager.state()).toBe("OFFLINE");
      expect(socket.readyState).toBe(3);
      expect(socket.sent.map(raw => JSON.parse(raw).type)).not.toContain("agent.ready");
      expect(socket.sent.map(raw => JSON.parse(raw).type)).not.toContain("heartbeat");
      expect(intervals.mock.calls.some(([, ms]) => ms === 12_345)).toBe(false);
      expect({ refreshes, connections, retries }).toEqual({ refreshes: 1, connections: 1, retries: 0 });
      expect(fixture.sessions).toHaveLength(1);
    } finally {
      controller.abort();
      await manager.close();
      await outcome;
    }
  }, 10_000);
});
