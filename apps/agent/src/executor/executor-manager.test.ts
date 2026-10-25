import { describe, expect, it, vi } from "vitest";
import {
  ExecutorManager,
  type ExecutorClient,
} from "./executor-manager.js";

function fakeClient(): ExecutorClient & { closeCalls: number } {
  return {
    closeCalls: 0,
    async listTools() {
      return [{ name: "read_file" }];
    },
    async callTool() {
      return { content: [] };
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

describe("ExecutorManager", () => {
  it("emits EXECUTOR_STARTING then READY only after local MCP initializes", async () => {
    const states: string[] = [];
    const client = fakeClient();
    const manager = new ExecutorManager({
      startClient: vi.fn().mockResolvedValue(client),
      onState: (state) => states.push(state),
    });

    expect(manager.state()).toBe("AUTHENTICATED");
    await manager.start();

    expect(states).toEqual(["EXECUTOR_STARTING", "READY"]);
    expect(manager.state()).toBe("READY");
  });

  it("moves to EXECUTOR_FAILED when startup or the running client fails", async () => {
    const manager = new ExecutorManager({
      startClient: vi.fn().mockRejectedValue(new Error("spawn failed")),
    });

    await expect(manager.start()).rejects.toThrow("spawn failed");
    expect(manager.state()).toBe("EXECUTOR_FAILED");

    const recovered = fakeClient();
    manager.setClientFactory(vi.fn().mockResolvedValue(recovered));
    await manager.restart();
    expect(manager.state()).toBe("READY");

    manager.markCrashed();
    expect(manager.state()).toBe("EXECUTOR_FAILED");
  });

  it("reuses a READY client rather than restarting it", async () => {
    const client = fakeClient();
    const startClient = vi.fn().mockResolvedValue(client);
    const manager = new ExecutorManager({ startClient });

    await manager.start();
    await manager.start();

    expect(startClient).toHaveBeenCalledTimes(1);
    expect(client.closeCalls).toBe(0);
  });
});

it("notifies invalidation on replacement and ignores close callbacks from an old client", async () => {
  const clients = [fakeClient(), fakeClient()];
  const closes: Array<() => void> = [];
  for (const client of clients) client.onClose = (handler) => { closes.push(handler); };
  let index = 0;
  const manager = new ExecutorManager({ startClient: async () => clients[index++]! });
  await manager.start();
  let invalidations = 0;
  const stop = manager.onInvalidated(() => { invalidations++; });
  await manager.restart(); expect(invalidations).toBe(1);
  closes[0]!(); expect(manager.state()).toBe("READY"); expect(invalidations).toBe(1);
  closes[1]!(); expect(manager.state()).toBe("EXECUTOR_FAILED"); expect(invalidations).toBe(2);
  stop(); manager.markIncompatible(); expect(invalidations).toBe(2);
});

it("coalesces concurrent executor startup to one client", async () => {
  const entered = Promise.withResolvers<void>();
  let release!: () => void;
  let starts = 0;
  const manager = new ExecutorManager({ startClient: async () => {
    starts++; entered.resolve(); await new Promise<void>((resolve) => { release = resolve; }); return fakeClient();
  } });
  const one = manager.start(); const two = manager.start();
  await entered.promise;
  expect(starts).toBe(1); release(); await Promise.all([one, two]);
  expect(manager.state()).toBe("READY");
});

it("does not let a late startup overwrite an invalidated executor epoch", async () => {
  const entered = Promise.withResolvers<void>();
  let release!: () => void;
  const client = fakeClient();
  const manager = new ExecutorManager({ startClient: async () => {
    entered.resolve();
    await new Promise<void>((resolve) => { release = resolve; }); return client;
  } });
  const pending = manager.start(); await entered.promise; manager.markIncompatible(); release(); await pending;
  expect(manager.state()).toBe("INCOMPATIBLE"); expect(client.closeCalls).toBe(1);
});

it("serializes executor replacement and blocks new startup until the old subprocess is closed", async () => {
  const entered = Promise.withResolvers<void>();
  let release!: () => void;
  const old = fakeClient();
  old.close = async () => { old.closeCalls++; entered.resolve(); await new Promise<void>((resolve) => { release = resolve; }); };
  const next = fakeClient();
  let factoryCalls = 0;
  const manager = new ExecutorManager({ startClient: async () => (++factoryCalls === 1 ? old : next) });
  await manager.start();
  const replacement = manager.restart();
  expect(manager.state()).toBe("EXECUTOR_FAILED");
  const inParallel = manager.start();
  await entered.promise;
  expect(factoryCalls).toBe(1);
  release();
  await Promise.all([replacement, inParallel]);
  expect(factoryCalls).toBe(2);
  expect(manager.state()).toBe("READY");
  expect(old.closeCalls).toBe(1);
});

it("does not start a replacement after the old executor reports an unconfirmed shutdown", async () => {
  let created = 0;
  const old = fakeClient();
  old.close = async () => { throw new Error("close failed"); };
  const manager = new ExecutorManager({
    startClient: async () => (++created === 1 ? old : fakeClient()),
  });
  await manager.start();
  await expect(manager.restart()).rejects.toThrow(/shutdown|close/i);
  expect(manager.state()).toBe("EXECUTOR_FAILED");
  await expect(manager.start()).rejects.toThrow(/shutdown|close/i);
  await expect(manager.restart()).rejects.toThrow(/shutdown|close/i);
  manager.markCrashed();
  await expect(manager.start()).rejects.toThrow(/shutdown|close/i);
  expect(created).toBe(1);
});

it("rejects replacement while an invalidated factory has no cleanup handle, then recovers after its late return", async () => {
  const entered = Promise.withResolvers<void>();
  let release!: () => void;
  const old = fakeClient();
  let started = 0;
  const manager = new ExecutorManager({startClient: async () => {
    if (++started === 1) { entered.resolve(); await new Promise<void>(resolve => { release = resolve; }); }
    return started === 1 ? old : fakeClient();
  }});
  let startupFailure: unknown;
  const pendingStart = manager.start().catch((error: unknown) => { startupFailure = error; });
  await entered.promise;
  let replacementFailure: unknown;
  const replacement = manager.restart().catch((error: unknown) => { replacementFailure = error; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(startupFailure).toBeInstanceOf(Error);
    expect(replacementFailure).toBeInstanceOf(Error);
    expect(started).toBe(1);
    await expect(manager.start()).rejects.toThrow(/shutdown|pending/i);
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(old.closeCalls).toBe(1);
    expect(started).toBe(1);
    expect(manager.state()).toBe("EXECUTOR_FAILED");
    await manager.restart();
    expect(started).toBe(2);
    expect(manager.state()).toBe("READY");
  } finally {
    release();
    await Promise.all([pendingStart, replacement]);
    await manager.close();
  }
});

it("fences recovery when a superseded startup cannot close its subprocess", async () => {
  const entered = Promise.withResolvers<void>();
  let release!: () => void;
  let started = 0;
  const manager = new ExecutorManager({ startClient: async () => {
    started++;
    entered.resolve();
    await new Promise<void>(resolve => { release = resolve; });
    const client = fakeClient();
    client.close = async () => { throw new Error("unable to stop pending startup"); };
    return client;
  } });
  const initial = manager.start();
  await entered.promise;
  const replacement = manager.restart();
  release();
  await expect(initial).rejects.toThrow(/shutdown/i);
  await expect(replacement).rejects.toThrow(/shutdown/i);
  expect(manager.state()).toBe("EXECUTOR_FAILED");
  await expect(manager.start()).rejects.toThrow(/shutdown/i);
  expect(started).toBe(1);
});

it("reports OFFLINE after a failed shutdown but forbids reusing the manager", async () => {
  const client = fakeClient();
  client.close = async () => { throw new Error("close failed"); };
  let starts = 0;
  const manager = new ExecutorManager({ startClient: async () => { starts++; return client; } });
  await manager.start();
  await expect(manager.close()).rejects.toThrow(/shutdown/i);
  expect(manager.state()).toBe("OFFLINE");
  await expect(manager.start()).rejects.toThrow(/shutdown/i);
  expect(starts).toBe(1);
});

describe("client ownership across failed and invalidated initialization", () => {
  it("owns a client registered before its factory handshake fails", async () => {
    const client = fakeClient();
    const failure = new Error("handshake failed");
    const manager = new ExecutorManager({ startClient: async (onCreated) => {
      onCreated(client);
      throw failure;
    } });
    await expect(manager.start()).rejects.toBe(failure);
    expect(client.closeCalls).toBe(1);
    expect(manager.state()).toBe("EXECUTOR_FAILED");
  });

  it("closes a spawned client when listing tools fails", async () => {
    const client = fakeClient();
    const failure = new Error("tool registry failed");
    client.listTools = async () => { throw failure; };
    const manager = new ExecutorManager({ startClient: async () => client });

    await expect(manager.start()).rejects.toBe(failure);
    expect(client.closeCalls).toBe(1);
    expect(manager.state()).toBe("EXECUTOR_FAILED");
    await manager.close();
    expect(client.closeCalls).toBe(1);
  });

  it("does not publish READY when the injected tool contract validator rejects the catalog", async () => {
    const client = fakeClient();
    const failure = new Error("Executor catalog does not match the packaged contract");
    const states: string[] = [];
    const manager = new ExecutorManager({
      startClient: async () => client,
      validateTools: () => { throw failure; },
      onState: state => states.push(state),
    });
    await expect(manager.start()).rejects.toBe(failure);
    expect(states).not.toContain("READY");
    expect(manager.state()).toBe("EXECUTOR_FAILED");
    expect(client.closeCalls).toBe(1);
  });

  it("cleans up if catalog validation invalidates the pending client", async () => {
    const client = fakeClient();
    const manager = new ExecutorManager({
      startClient: async () => client,
      validateTools: () => manager.markIncompatible(),
    });
    await manager.start();
    expect(manager.state()).toBe("INCOMPATIBLE");
    expect(client.closeCalls).toBe(1);
  });

  it("retains the READY client's close handle after protocol incompatibility", async () => {
    const client = fakeClient();
    const manager = new ExecutorManager({ startClient: async () => client });
    await manager.start();
    manager.markIncompatible();

    await expect(manager.callTool("write_file", {})).rejects.toThrow(/not READY/);
    await expect(manager.start()).rejects.toThrow(/incompatible/i);
    await expect(manager.restart()).rejects.toThrow(/incompatible/i);
    await manager.close();
    await manager.close();
    expect(client.closeCalls).toBe(1);
  });

  it("keeps a failed initialization cleanup owned until an explicit close succeeds", async () => {
    const client = fakeClient();
    const listingFailure = new Error("tool registry failed");
    client.listTools = async () => { throw listingFailure; };
    client.close = async () => {
      client.closeCalls++;
      if (client.closeCalls === 1) throw new Error("child still running");
    };
    const manager = new ExecutorManager({ startClient: async () => client });

    await expect(manager.start()).rejects.toThrow(/shutdown/i);
    expect(client.closeCalls).toBe(1);
    await expect(manager.start()).rejects.toThrow(/shutdown/i);
    await manager.close();
    expect(client.closeCalls).toBe(2);
    await manager.close();
    expect(client.closeCalls).toBe(2);
  });

  it("rejects shutdown confirmation for an unregistered pending factory and cleans up its late return", async () => {
    const created = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    const client = fakeClient();
    const manager = new ExecutorManager({ startClient: () => { entered.resolve(); return created.promise; } });
    let startupFailure: unknown;
    const startup = manager.start().catch((error: unknown) => { startupFailure = error; });
    await entered.promise;
    let stopped = false;
    let shutdownFailure: unknown;
    const shutdown = manager.close().then(() => { stopped = true; }, (error: unknown) => { shutdownFailure = error; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(startupFailure).toBeInstanceOf(Error);
      expect(shutdownFailure).toBeInstanceOf(Error);
      created.resolve(client);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(client.closeCalls).toBe(1);
      expect(manager.state()).toBe("OFFLINE");
    } finally {
      created.resolve(client);
      await Promise.all([startup, shutdown]);
      await manager.close();
    }
  });

  it("cannot publish READY if the child closes while tools are being listed", async () => {
    const listed = Promise.withResolvers<Array<{ name: string }>>();
    const entered = Promise.withResolvers<void>();
    const client = fakeClient();
    let closed: (() => void) | undefined;
    client.onClose = (listener) => { closed = listener; };
    client.listTools = () => { entered.resolve(); return listed.promise; };
    const states: string[] = [];
    const manager = new ExecutorManager({ startClient: async () => client, onState: state => states.push(state) });
    const startup = manager.start();
    await entered.promise;
    closed?.();
    listed.resolve([{ name: "read_file" }]);
    await startup;
    expect(states).not.toContain("READY");
    expect(manager.state()).toBe("EXECUTOR_FAILED");
    expect(client.closeCalls).toBe(1);
  });

  it("does not lose a crashed client's cleanup handle", async () => {
    const client = fakeClient();
    const manager = new ExecutorManager({ startClient: async () => client });
    await manager.start();
    manager.markCrashed();
    await manager.close();
    expect(client.closeCalls).toBe(1);
  });

  it("coalesces close while a restart is draining and prevents a late replacement", async () => {
    const drained = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const old = fakeClient();
    old.close = () => { old.closeCalls++; entered.resolve(); return drained.promise; };
    let starts = 0;
    const manager = new ExecutorManager({ startClient: async () => { starts++; return old; } });
    await manager.start();
    const restart = manager.restart();
    await entered.promise;
    let stopped = false;
    const firstClose = manager.close().then(() => { stopped = true; });
    const secondClose = manager.close();
    await Promise.resolve();
    expect(stopped).toBe(false);
    drained.resolve();
    await Promise.all([restart, firstClose, secondClose]);
    expect(starts).toBe(1);
    expect(old.closeCalls).toBe(1);
    expect(manager.state()).toBe("OFFLINE");
  });

  it("coalesces simultaneous restarts into one replacement", async () => {
    const drained = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const old = fakeClient();
    old.close = () => { old.closeCalls++; entered.resolve(); return drained.promise; };
    let starts = 0;
    const manager = new ExecutorManager({ startClient: async () => (++starts === 1 ? old : fakeClient()) });
    await manager.start();
    const first = manager.restart();
    const second = manager.restart();
    await entered.promise;
    expect(starts).toBe(1);
    drained.resolve();
    await Promise.all([first, second]);
    expect(starts).toBe(2);
    expect(old.closeCalls).toBe(1);
    await manager.close();
  });

  it("does not create a second client when a state observer calls start", async () => {
    let starts = 0;
    let reentrant: Promise<void> | undefined;
    const manager = new ExecutorManager({
      startClient: async () => { starts++; return fakeClient(); },
      onState: state => { if (state === "EXECUTOR_STARTING") reentrant = manager.start(); },
    });
    await manager.start();
    await reentrant;
    expect(starts).toBe(1);
    await manager.close();
  });

  it("blocks startup while shutdown is still in progress", async () => {
    const drained = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const client = fakeClient();
    client.close = () => { client.closeCalls++; entered.resolve(); return drained.promise; };
    let starts = 0;
    const manager = new ExecutorManager({ startClient: async () => { starts++; return client; } });
    await manager.start();
    const shutdown = manager.close();
    await entered.promise;
    await expect(manager.start()).rejects.toThrow(/closing|shutdown/i);
    drained.resolve();
    await shutdown;
    expect(starts).toBe(1);
  });

  it.each(["synchronous", "asynchronous"])("reports %s observer failures without interrupting shutdown or other observers", async kind => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      const fail = () => {
        if (kind === "asynchronous") return Promise.reject(new Error("observer failed"));
        throw new Error("observer failed");
      };
      const client = fakeClient();
      const manager = new ExecutorManager({
        startClient: async () => client,
        onState: fail,
      });
      let invalidations = 0;
      manager.onStateChanged(fail);
      manager.onInvalidated(fail);
      manager.onInvalidated(() => { invalidations++; });
      await manager.start();
      expect(manager.state()).toBe("READY");
      await manager.close();
      expect(client.closeCalls).toBe(1);
      expect(invalidations).toBe(1);
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
});
