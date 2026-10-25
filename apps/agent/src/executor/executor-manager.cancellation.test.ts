import { describe, expect, it } from "vitest";
import { ExecutorManager, type ExecutorClient } from "./executor-manager.js";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function clientFixture(): ExecutorClient & { closes: number } {
  return {
    closes: 0,
    listTools: async () => [{ name: "read_file" }],
    callTool: async () => ({}),
    async close() { this.closes++; },
  };
}

describe("ExecutorManager initialization cancellation", () => {
  it("closes a registered client without waiting for a late factory result", async () => {
    const client = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    const states: string[] = [];
    const manager = new ExecutorManager({
      onState: state => states.push(state),
      startClient: onCreated => {
        onCreated(client);
        entered.resolve();
        return factory.promise;
      },
    });
    let startSettled = false;
    const starting = manager.start().finally(() => { startSettled = true; });
    const startResult = starting.catch((error: unknown) => error);
    await entered.promise;
    let closeSettled = false;
    const closing = manager.close().then(() => { closeSettled = true; });
    const closeResult = closing.catch((error: unknown) => error);
    try {
      await turn();
      expect(client.closes).toBe(1);
      expect(closeSettled).toBe(true);
      expect(startSettled).toBe(true);
      factory.resolve(client);
      await turn();
      expect(states).not.toContain("READY");
      expect(manager.state()).toBe("OFFLINE");
      expect(client.closes).toBe(1);
      expect(await closeResult).toBeUndefined();
    } finally {
      factory.resolve(client);
      await startResult;
      await closeResult;
      await manager.close();
    }
  });

  it("cancels hung tool discovery and coalesces concurrent close calls", async () => {
    const client = clientFixture();
    const listed = Promise.withResolvers<Array<{ name: string }>>();
    const entered = Promise.withResolvers<void>();
    client.listTools = () => { entered.resolve(); return listed.promise; };
    const manager = new ExecutorManager({ startClient: async () => client });
    let startSettled = false;
    const starting = manager.start().finally(() => { startSettled = true; });
    const startResult = starting.catch((error: unknown) => error);
    await entered.promise;
    let closeSettled = false;
    const closing = Promise.all([manager.close(), manager.close()]).then(() => { closeSettled = true; });
    const closeResult = closing.catch((error: unknown) => error);
    try {
      await turn();
      expect(client.closes).toBe(1);
      expect(closeSettled).toBe(true);
      expect(startSettled).toBe(true);
      listed.resolve([{ name: "read_file" }]);
      await turn();
      expect(manager.state()).toBe("OFFLINE");
      expect(await closeResult).toBeUndefined();
    } finally {
      listed.resolve([{ name: "read_file" }]);
      await startResult;
      await closeResult;
      await manager.close();
    }
  });

  it("passes one cancellation signal through the factory and tool discovery", async () => {
    const client = clientFixture();
    const listed = Promise.withResolvers<Array<{ name: string }>>();
    const entered = Promise.withResolvers<void>();
    let factorySignal: AbortSignal | undefined;
    let listingSignal: AbortSignal | undefined;
    client.listTools = options => {
      listingSignal = options?.signal;
      entered.resolve();
      return listed.promise;
    };
    const manager = new ExecutorManager({ startClient: async (onCreated, signal) => {
      factorySignal = signal;
      onCreated(client);
      return client;
    } });
    const starting = manager.start().catch((error: unknown) => error);
    await entered.promise;
    const closing = manager.close().catch((error: unknown) => error);
    try {
      await turn();
      expect(factorySignal).toBeInstanceOf(AbortSignal);
      expect(listingSignal).toBe(factorySignal);
      expect(listingSignal?.aborted).toBe(true);
      expect(client.closes).toBe(1);
    } finally {
      listed.resolve([{ name: "read_file" }]);
      await starting;
      await closing;
    }
  });

  it("rejects an unregistered pending factory promptly and cleans its late result before recovery", async () => {
    const old = clientFixture();
    const next = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    let starts = 0;
    const manager = new ExecutorManager({ startClient: () => {
      if (++starts === 1) { entered.resolve(); return factory.promise; }
      return Promise.resolve(next);
    } });
    let startupResult: unknown;
    const starting = manager.start().catch((error: unknown) => { startupResult = error; });
    await entered.promise;
    let shutdownResult: unknown;
    const closing = manager.close().catch((error: unknown) => { shutdownResult = error; });
    try {
      await turn();
      expect(startupResult).toBeInstanceOf(Error);
      expect(shutdownResult).toBeInstanceOf(Error);
      await expect(manager.start()).rejects.toThrow(/shutdown|pending/i);
      await expect(manager.restart()).rejects.toThrow(/shutdown|pending/i);
      expect(starts).toBe(1);
      factory.resolve(old);
      await turn();
      expect(old.closes).toBe(1);
      expect(manager.state()).toBe("OFFLINE");
      await manager.start();
      expect(starts).toBe(2);
      expect(manager.state()).toBe("READY");
    } finally {
      factory.resolve(old);
      await starting;
      await closing;
      await manager.close();
    }
  });

  it("releases the pending factory fence after a late rejection without a client", async () => {
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    let starts = 0;
    const manager = new ExecutorManager({ startClient: () => {
      if (++starts === 1) { entered.resolve(); return factory.promise; }
      return Promise.resolve(clientFixture());
    } });
    const starting = manager.start().catch((error: unknown) => error);
    await entered.promise;
    let shutdownResult: unknown;
    const closing = manager.close().catch((error: unknown) => { shutdownResult = error; });
    try {
      await turn();
      expect(shutdownResult).toBeInstanceOf(Error);
      factory.reject(new Error("factory stopped before creating a client"));
      await turn();
      await manager.start();
      expect(starts).toBe(2);
      expect(manager.state()).toBe("READY");
    } finally {
      factory.reject(new Error("factory stopped before creating a client"));
      await starting;
      await closing;
      await manager.close();
    }
  });

  it("cleans a late onCreated client even while its cancelled factory remains pending", async () => {
    const old = clientFixture();
    const next = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    let register: ((client: ExecutorClient) => void) | undefined;
    let starts = 0;
    const manager = new ExecutorManager({ startClient: onCreated => {
      if (++starts === 1) { register = onCreated; entered.resolve(); return factory.promise; }
      return Promise.resolve(next);
    } });
    const starting = manager.start().catch((error: unknown) => error);
    await entered.promise;
    let shutdownResult: unknown;
    const closing = manager.close().catch((error: unknown) => { shutdownResult = error; });
    try {
      await turn();
      expect(shutdownResult).toBeInstanceOf(Error);
      register?.(old);
      await turn();
      expect(old.closes).toBe(1);
      await manager.start();
      expect(manager.state()).toBe("READY");
      factory.resolve(old);
      await turn();
      expect(old.closes).toBe(1);
      expect(next.closes).toBe(0);
      expect(manager.state()).toBe("READY");
    } finally {
      factory.resolve(old);
      await starting;
      await closing;
      await manager.close();
    }
  });

  it("restarts a registered hung factory only after physical close and ignores its late result", async () => {
    const old = clientFixture();
    const next = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const drained = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let oldClosed: (() => void) | undefined;
    old.onClose = listener => { oldClosed = listener; };
    old.close = () => { old.closes++; return drained.promise; };
    let starts = 0;
    const manager = new ExecutorManager({ startClient: onCreated => {
      if (++starts === 1) { onCreated(old); entered.resolve(); return factory.promise; }
      onCreated(next);
      return Promise.resolve(next);
    } });
    const starting = manager.start().catch((error: unknown) => error);
    await entered.promise;
    let restarted = false;
    const replacing = Promise.all([manager.restart(), manager.restart()]).then(() => { restarted = true; });
    const replacement = replacing.catch((error: unknown) => error);
    try {
      await turn();
      expect(old.closes).toBe(1);
      expect(starts).toBe(1);
      expect(restarted).toBe(false);
      drained.resolve();
      await turn();
      expect(restarted).toBe(true);
      expect(starts).toBe(2);
      expect(manager.state()).toBe("READY");
      factory.resolve(old);
      await turn();
      oldClosed?.();
      expect(old.closes).toBe(1);
      expect(next.closes).toBe(0);
      expect(manager.state()).toBe("READY");
      expect(await replacement).toBeUndefined();
    } finally {
      drained.resolve();
      factory.resolve(old);
      await starting;
      await replacement;
      await manager.close();
    }
  });

  it.each(["factory", "tools"] as const)("cancels %s initialization when the protocol becomes incompatible", async stage => {
    const client = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const listed = Promise.withResolvers<Array<{ name: string }>>();
    const entered = Promise.withResolvers<void>();
    if (stage === "tools") client.listTools = () => { entered.resolve(); return listed.promise; };
    const manager = new ExecutorManager({ startClient: onCreated => {
      onCreated(client);
      if (stage === "factory") { entered.resolve(); return factory.promise; }
      return Promise.resolve(client);
    } });
    let settled = false;
    const starting = manager.start().finally(() => { settled = true; }).catch((error: unknown) => error);
    await entered.promise;
    manager.markIncompatible();
    try {
      await turn();
      expect(settled).toBe(true);
      expect(client.closes).toBe(1);
      expect(manager.state()).toBe("INCOMPATIBLE");
      await expect(manager.start()).rejects.toThrow(/incompatible/i);
      await expect(manager.restart()).rejects.toThrow(/incompatible/i);
      factory.resolve(client);
      listed.resolve([{ name: "read_file" }]);
      await turn();
      expect(manager.state()).toBe("INCOMPATIBLE");
      expect(client.closes).toBe(1);
    } finally {
      factory.resolve(client);
      listed.resolve([{ name: "read_file" }]);
      await starting;
      await manager.close();
    }
  });

  it.each(["factory", "tools"] as const)("does not automatically retry a failed %s cancellation cleanup", async stage => {
    const client = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const listed = Promise.withResolvers<Array<{ name: string }>>();
    const entered = Promise.withResolvers<void>();
    let failClose = true;
    client.close = async () => {
      client.closes++;
      if (failClose) throw new Error("subprocess still owns its pipes");
    };
    if (stage === "tools") client.listTools = () => { entered.resolve(); return listed.promise; };
    const manager = new ExecutorManager({ startClient: onCreated => {
      onCreated(client);
      if (stage === "factory") { entered.resolve(); return factory.promise; }
      return Promise.resolve(client);
    } });
    let startupResult: unknown;
    const starting = manager.start().catch((error: unknown) => { startupResult = error; });
    await entered.promise;
    let shutdownResult: unknown;
    const closing = Promise.all([manager.close(), manager.close()]).catch((error: unknown) => { shutdownResult = error; });
    try {
      await turn();
      expect(startupResult).toBeInstanceOf(Error);
      expect(shutdownResult).toBeInstanceOf(Error);
      expect(client.closes).toBe(1);
      expect(manager.state()).toBe("OFFLINE");
      await expect(manager.start()).rejects.toThrow(/shutdown/i);
      await expect(manager.restart()).rejects.toThrow(/shutdown/i);
      factory.resolve(client);
      listed.resolve([{ name: "read_file" }]);
      await turn();
      expect(client.closes).toBe(1);
      failClose = false;
      await manager.close();
      expect(client.closes).toBe(2);
      await manager.close();
      expect(client.closes).toBe(2);
    } finally {
      failClose = false;
      factory.resolve(client);
      listed.resolve([{ name: "read_file" }]);
      await starting;
      await closing;
      await manager.close();
    }
  });

  it("retains ownership when cleanup of an unregistered late factory result fails", async () => {
    const client = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    let failClose = true;
    client.close = async () => { client.closes++; if (failClose) throw new Error("late child still running"); };
    const manager = new ExecutorManager({ startClient: () => { entered.resolve(); return factory.promise; } });
    const starting = manager.start().catch((error: unknown) => error);
    await entered.promise;
    let shutdownResult: unknown;
    const closing = manager.close().catch((error: unknown) => { shutdownResult = error; });
    try {
      await turn();
      expect(shutdownResult).toBeInstanceOf(Error);
      factory.resolve(client);
      await turn();
      expect(client.closes).toBe(1);
      await expect(manager.start()).rejects.toThrow(/shutdown/i);
      await expect(manager.restart()).rejects.toThrow(/shutdown/i);
      expect(manager.state()).toBe("OFFLINE");
      failClose = false;
      await manager.close();
      expect(client.closes).toBe(2);
    } finally {
      failClose = false;
      factory.resolve(client);
      await starting;
      await closing;
      await manager.close();
    }
  });

  it("cancels a replacement during tool discovery without publishing another READY", async () => {
    const old = clientFixture();
    const next = clientFixture();
    const listed = Promise.withResolvers<Array<{ name: string }>>();
    const entered = Promise.withResolvers<void>();
    next.listTools = () => { entered.resolve(); return listed.promise; };
    let starts = 0;
    const states: string[] = [];
    const manager = new ExecutorManager({
      startClient: async () => (++starts === 1 ? old : next),
      onState: state => states.push(state),
    });
    await manager.start();
    let restarted = false;
    const replacing = manager.restart().finally(() => { restarted = true; }).catch((error: unknown) => error);
    await entered.promise;
    let stopped = false;
    const closing = manager.close().then(() => { stopped = true; }).catch((error: unknown) => error);
    try {
      await turn();
      expect(restarted).toBe(true);
      expect(stopped).toBe(true);
      expect(old.closes).toBe(1);
      expect(next.closes).toBe(1);
      listed.resolve([{ name: "read_file" }]);
      await turn();
      expect(states.filter(state => state === "READY")).toHaveLength(1);
      expect(manager.state()).toBe("OFFLINE");
    } finally {
      listed.resolve([{ name: "read_file" }]);
      await replacing;
      await closing;
      await manager.close();
    }
  });

  it("preserves a newer incompatible state raised synchronously by an abort listener", async () => {
    const client = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    const states: string[] = [];
    let starts = 0;
    const manager = new ExecutorManager({
      onState: state => states.push(state),
      startClient: (onCreated, signal) => {
        starts++;
        onCreated(client);
        signal.addEventListener("abort", () => manager.markIncompatible(), { once: true });
        entered.resolve();
        return factory.promise;
      },
    });
    const starting = manager.start();
    await entered.promise;
    try {
      await manager.restart();
      await starting;
      expect(manager.state()).toBe("INCOMPATIBLE");
      expect(states).toEqual(["EXECUTOR_STARTING", "INCOMPATIBLE"]);
      expect(client.closes).toBe(1);
      await expect(manager.start()).rejects.toThrow(/incompatible/i);
      expect(starts).toBe(1);
    } finally {
      factory.resolve(client);
      await starting;
      await manager.close();
    }
  });

  it("does not send a stale starting state after an observer synchronously invalidates it", async () => {
    const states: string[] = [];
    let starts = 0;
    const manager = new ExecutorManager({
      onState: state => { if (state === "EXECUTOR_STARTING") manager.markIncompatible(); },
      startClient: async () => { starts++; return clientFixture(); },
    });
    manager.onStateChanged(state => states.push(state));
    await manager.start();
    expect(manager.state()).toBe("INCOMPATIBLE");
    expect(states).toEqual(["INCOMPATIBLE"]);
    expect(starts).toBe(0);
    await manager.close();
  });
});
