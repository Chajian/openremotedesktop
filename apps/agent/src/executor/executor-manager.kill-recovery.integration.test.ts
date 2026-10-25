import type { ChildProcessWithoutNullStreams, SpawnOptionsWithStdioTuple, StdioPipe } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopCommanderClient } from "@open-desktop-remote/desktop-commander-adapter";
import { ExecutorManager } from "./executor-manager.js";

type Session = {
  directory: string;
  mode: "kill" | "eof";
  child?: ChildProcessWithoutNullStreams;
  client?: DesktopCommanderClient;
  descendantPid?: number;
  closed: boolean;
  closing: PromiseWithResolvers<void>;
};

const fixture = vi.hoisted(() => ({ sessions: [] as Session[] }));

// Change only the executable's arguments. Agent, adapter, MCP SDK, native
// process handles and owned transport cleanup are the production implementations.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(command: string, _args: string[], options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>) {
      const session = fixture.sessions.at(-1);
      if (!session) throw new Error("Unexpected fixture spawn");
      const path = fileURLToPath(new URL("../../../../packages/desktop-commander-adapter/src/fixtures/inherited-stdio-server.mjs", import.meta.url));
      const child = actual.spawn(command, [path, session.mode, session.directory], options);
      session.child = child;
      child.once("close", () => { session.closed = true; session.closing.resolve(); });
      return child;
    },
  };
});

async function within<T>(pending: Promise<T>, milliseconds = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fixture deadline exceeded")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function started(session: Session): asserts session is Session & {
  child: ChildProcessWithoutNullStreams; client: DesktopCommanderClient; descendantPid: number;
} {
  if (!session.child || !session.client || session.descendantPid === undefined) throw new Error("Fixture did not start");
}

async function startFixture(mode: Session["mode"], onCreated: (client: DesktopCommanderClient) => void) {
  const session: Session = {
    mode, directory: await mkdtemp(join(tmpdir(), "odr-manager-inherited-stdio-")),
    closed: false, closing: Promise.withResolvers<void>(),
  };
  fixture.sessions.push(session);
  const client = await DesktopCommanderClient.start({ onCreated(client) { session.client = client; onCreated(client); } });
  const ready: unknown = JSON.parse(await readFile(join(session.directory, "ready.json"), "utf8"));
  if (!ready || typeof ready !== "object" || !("descendantPid" in ready) || typeof ready.descendantPid !== "number") {
    throw new Error("Fixture descendant did not register its PID");
  }
  session.descendantPid = ready.descendantPid;
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const sessions = fixture.sessions.splice(0);
  await Promise.all(sessions.map(async session => {
    await writeFile(join(session.directory, "stop-descendant"), "stop");
    if (session.child && session.child.exitCode === null && session.child.signalCode === null) session.child.kill("SIGKILL");
    if (session.child) await within(session.closing.promise);
    const descendantPid = session.descendantPid;
    if (descendantPid !== undefined) {
      const deadline = performance.now() + 3_000;
      while (isAlive(descendantPid)) {
        if (performance.now() >= deadline) throw new Error("Fixture descendant did not exit");
        await delay(20);
      }
      await readFile(join(session.directory, "descendant-exited"), "utf8");
    }
    await session.client?.close();
    await rm(session.directory, { recursive: true, force: true });
  }));
});

describe("ExecutorManager recovery after inherited-pipe shutdown", () => {
  it.skipIf(process.platform === "win32")("waits for confirmed SIGKILL cleanup, then starts the replacement on the first restart", async () => {
    let starts = 0;
    const manager = new ExecutorManager({ startClient: async onCreated => {
      if (starts > 0) expect(fixture.sessions[0]!.closed).toBe(true);
      return startFixture(starts++ === 0 ? "kill" : "eof", onCreated);
    } });
    await manager.start();
    const original = fixture.sessions[0]!;
    started(original);
    const termSent = Promise.withResolvers<void>();
    const kill = original.child.kill.bind(original.child);
    vi.spyOn(original.child, "kill").mockImplementation(signal => {
      const result = kill(signal);
      if (signal === "SIGTERM") termSent.resolve();
      return result;
    });
    const restart = manager.restart();
    await within(termSent.promise);
    expect(starts).toBe(1);
    expect(original.child.signalCode).toBeNull();
    expect(isAlive(original.child.pid!)).toBe(true);
    await Promise.all([restart, manager.start()]);
    expect(starts).toBe(2);
    expect(manager.state()).toBe("READY");
    expect(original.closed).toBe(true);
    expect(isAlive(original.descendantPid)).toBe(true);
    await manager.close();
  }, 15_000);

  it("retains the recovery block until a failed real shutdown is explicitly confirmed", async () => {
    let starts = 0;
    const manager = new ExecutorManager({ startClient: onCreated => startFixture(starts++ === 0 ? "kill" : "eof", onCreated) });
    await manager.start();
    const original = fixture.sessions[0]!;
    started(original);
    const kill = vi.spyOn(original.child, "kill").mockReturnValue(false);
    await expect(manager.restart()).rejects.toThrow("shutdown could not be confirmed");
    expect(original.closed).toBe(false);
    expect(isAlive(original.child.pid!)).toBe(true);
    expect(starts).toBe(1);
    await expect(manager.start()).rejects.toThrow("shutdown could not be confirmed");
    await expect(manager.restart()).rejects.toThrow("shutdown could not be confirmed");
    expect(starts).toBe(1);
    kill.mockRestore();
    await manager.close();
    expect(original.closed).toBe(true);
    await manager.start();
    expect(starts).toBe(2);
    expect(manager.state()).toBe("READY");
    await manager.close();
  }, 15_000);
});
