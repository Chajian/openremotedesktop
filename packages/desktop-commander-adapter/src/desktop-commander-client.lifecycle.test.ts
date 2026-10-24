import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DesktopCommanderClient } from "./desktop-commander-client.js";

type Session = {
  child: ChildProcess;
  transport: StdioClientTransport;
  closed: boolean;
  closedPromise: Promise<void>;
};

const fixture = vi.hoisted(() => ({
  mode: "normal",
  sessions: [] as Session[],
}));

// Substitute only the executable fixture. Spawning, MCP initialization,
// signaling, stdio backpressure and child close events use the actual SDK.
vi.mock("@modelcontextprotocol/client/stdio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/client/stdio")>();
  return {
    ...actual,
    StdioClientTransport: class extends actual.StdioClientTransport {
      constructor(options: ConstructorParameters<typeof actual.StdioClientTransport>[0]) {
        super({
          ...options,
          args: [fileURLToPath(new URL("./fixtures/stdio-lifecycle-server.mjs", import.meta.url)), fixture.mode],
        });
      }

      override async start(): Promise<void> {
        const starting = super.start();
        // Test-only observation of the real ChildProcess lets assertions check
        // OS close rather than SDK pid, which becomes null before child exit.
        const child = Reflect.get(this, "_process") as ChildProcess;
        let resolveClosed!: () => void;
        const session: Session = {
          child,
          transport: this,
          closed: false,
          closedPromise: new Promise<void>((resolve) => { resolveClosed = resolve; }),
        };
        child.prependOnceListener("close", () => {
          session.closed = true;
          resolveClosed();
        });
        fixture.sessions.push(session);
        await starting;
      }
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  const sessions = fixture.sessions.splice(0);
  fixture.mode = "normal";
  await Promise.all(sessions.map(async (session) => {
    // Drain even when the production regression left stderr backpressured;
    // otherwise Node cannot emit close after the fixture process is killed.
    session.transport.stderr?.on("data", () => {});
    if (!session.closed) session.child.kill("SIGKILL");
    await session.closedPromise;
  }));
});

function currentSession(): Session {
  const session = fixture.sessions.at(-1);
  if (!session) throw new Error("Fixture child was not created");
  return session;
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture deadline exceeded")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Desktop Commander subprocess lifecycle", () => {
  it("sends the supplied release identity in the actual MCP handshake", async () => {
    const client = await DesktopCommanderClient.start({
      clientInfo: { name: "fixture-release-agent", version: "0.1.3" },
    });

    const result = await client.callTool("get_client_info", {});

    expect(result.content).toEqual([{
      type: "text",
      text: '{"name":"fixture-release-agent","version":"0.1.3"}',
    }]);
    await client.close();
  });

  it("preserves the default MCP identity when no client info is supplied", async () => {
    const client = await DesktopCommanderClient.start();

    const result = await client.callTool("get_client_info", {});

    expect(result.content).toEqual([{
      type: "text",
      text: '{"name":"open-desktop-remote-agent","version":"0.1.0"}',
    }]);
    await client.close();
  });

  it("waits for the real child close after forced termination", async () => {
    fixture.mode = "stubborn";
    const client = await DesktopCommanderClient.start();
    const session = currentSession();
    const pid = session.child.pid!;

    await client.close();

    expect(session.closed).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it("shares concurrent close attempts", async () => {
    const client = await DesktopCommanderClient.start();
    const closing = client.close();
    const concurrent = client.close();

    expect(concurrent).toBe(closing);
    await closing;
    expect(currentSession().closed).toBe(true);
  });

  it("notifies a subscriber registered after child close", async () => {
    const client = await DesktopCommanderClient.start();
    await client.close();
    let notifications = 0;

    client.onClose(() => { notifications += 1; });
    await client.close();

    expect(notifications).toBe(1);
  });

  it("contains observer failures and reports only a sanitized warning", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const client = await DesktopCommanderClient.start();
    let notifications = 0;
    client.onClose(() => { throw new Error("fixture observer diagnostic must stay private"); });
    client.onClose(() => { notifications += 1; });

    await client.close();

    expect(currentSession().closed).toBe(true);
    expect(notifications).toBe(1);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain("diagnostic must stay private");
  }, 10_000);

  it("contains a rejected promise from a late close observer", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const client = await DesktopCommanderClient.start();
    await client.close();

    client.onClose(async () => { throw new Error("fixture observer diagnostic must stay private"); });
    await Promise.resolve();

    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain("diagnostic must stay private");
  });

  it("drains stderr so a verbose child can finish initialization", async () => {
    fixture.mode = "stderr-flood";
    const output = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];

    const client = await within(DesktopCommanderClient.start(), 2_000);
    await client.close();

    expect(client).toBeInstanceOf(DesktopCommanderClient);
    for (const spy of output) expect(spy).not.toHaveBeenCalled();
  }, 10_000);

  it("registers ownership before connect and confirms cleanup of a rejected handshake", async () => {
    fixture.mode = "reject-stubborn";
    let owned: DesktopCommanderClient | undefined;
    let sessionsAtRegistration: number | undefined;

    await expect(DesktopCommanderClient.start({
      onCreated(client) {
        owned = client;
        sessionsAtRegistration = fixture.sessions.length;
      },
    })).rejects.toThrow("Fixture initialization rejected");

    expect(owned).toBeInstanceOf(DesktopCommanderClient);
    expect(sessionsAtRegistration).toBe(0);
    expect(currentSession().closed).toBe(true);
    await owned!.close();
  }, 10_000);

  it("rejects a mismatched server version and confirms owned child cleanup", async () => {
    fixture.mode = "version-mismatch";
    let owned: DesktopCommanderClient | undefined;

    await expect(DesktopCommanderClient.start({
      onCreated(client) { owned = client; },
    }).then(() => undefined)).rejects.toThrow("server version does not match");

    expect(owned).toBeInstanceOf(DesktopCommanderClient);
    expect(currentSession().closed).toBe(true);
    await owned!.close();
  });

  it("confirms a failed spawn without leaving a pending close", async () => {
    let owned: DesktopCommanderClient | undefined;
    await expect(DesktopCommanderClient.start({
      cwd: join(tmpdir(), `odr-missing-cwd-${randomUUID()}`),
      onCreated(client) { owned = client; },
    })).rejects.toThrow();

    expect(owned).toBeInstanceOf(DesktopCommanderClient);
    await within(owned!.close(), 1_000);
    expect(currentSession().closed).toBe(true);
  });

  it("settles cleanup when the ownership callback rejects before spawn", async () => {
    let owned: DesktopCommanderClient | undefined;
    await expect(DesktopCommanderClient.start({
      onCreated(client) {
        owned = client;
        throw new Error("Fixture ownership rejected");
      },
    }).then(() => undefined)).rejects.toThrow("Fixture ownership rejected");

    expect(fixture.sessions).toHaveLength(0);
    await within(owned!.close(), 1_000);
  });

  it("does not spawn after its early owner has already closed it", async () => {
    let closing: Promise<void> | undefined;
    await expect(DesktopCommanderClient.start({
      onCreated(client) { closing = client.close(); },
    }).then(() => undefined)).rejects.toThrow("closed before startup");

    await closing;
    expect(fixture.sessions).toHaveLength(0);
  });

  it("keeps failed close retryable until a real child close is observed", async () => {
    const client = await DesktopCommanderClient.start();
    const session = currentSession();
    let notifications = 0;
    client.onClose(() => { notifications += 1; });
    const close = vi.spyOn(session.transport, "close").mockResolvedValueOnce(undefined);

    await expect(within(client.close(), 3_000)).rejects.toThrow("close was not confirmed");
    expect(session.closed).toBe(false);
    expect(notifications).toBe(0);

    close.mockRestore();
    await client.close();
    expect(session.closed).toBe(true);
    expect(notifications).toBe(1);
  }, 10_000);

  it("does not hide failed startup cleanup from the early owner", async () => {
    const connect = Client.prototype.connect;
    const startupError = new Error("fixture startup diagnostic must stay private");
    const cleanupError = new Error("fixture cleanup diagnostic must stay private");
    vi.spyOn(Client.prototype, "connect").mockImplementationOnce(async function (this: Client, transport, options) {
      await connect.call(this, transport, options);
      vi.spyOn(transport, "close").mockRejectedValueOnce(cleanupError);
      throw startupError;
    });
    let owned: DesktopCommanderClient | undefined;

    const failure = await DesktopCommanderClient.start({
      onCreated(client) { owned = client; },
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe("Desktop Commander startup failed and subprocess cleanup was not confirmed");
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBe(startupError);
    expect(aggregate.errors[1]).toBe(cleanupError);

    expect(owned).toBeInstanceOf(DesktopCommanderClient);
    expect(currentSession().closed).toBe(false);
    await owned!.close();
    expect(currentSession().closed).toBe(true);
  });
});
