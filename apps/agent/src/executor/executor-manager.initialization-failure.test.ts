import { describe, expect, it } from "vitest";
import { ExecutorManager, type ExecutorClient, type ExecutorTool } from "./executor-manager.js";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function clientFixture() {
  let onClose: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const client: ExecutorClient & { closes: number } = {
    closes: 0,
    listTools: async () => [{ name: "read_file" }],
    callTool: async () => ({ content: [] }),
    onClose(handler) { onClose = handler; },
    close() {
      return closing ??= Promise.resolve().then(() => { client.closes++; onClose?.(); });
    },
  };
  return { client, closed: () => onClose?.() };
}

describe("ExecutorManager initialization failure attribution", () => {
  it.each(["factory", "tools"] as const)("preserves the exact %s error when its cleanup emits onClose before rejection", async stage => {
    const { client } = clientFixture();
    const failure = new Error("Fixture startup failure");
    const failAfterCleanup = async () => {
      try { throw failure; } finally { await client.close(); }
    };
    if (stage === "tools") client.listTools = failAfterCleanup;
    const states: string[] = [];
    const manager = new ExecutorManager({
      onState: state => states.push(state),
      startClient: async onCreated => {
        onCreated(client);
        if (stage === "factory") await failAfterCleanup();
        return client;
      },
    });
    try {
      await expect(manager.start()).rejects.toBe(failure);
      expect(manager.state()).toBe("EXECUTOR_FAILED");
      expect(states).toEqual(["EXECUTOR_STARTING", "EXECUTOR_FAILED"]);
      expect(client.closes).toBe(1);
      await expect(manager.callTool("write_file", {})).rejects.toThrow(/not READY/);
    } finally { await manager.close(); }
  });

  it("preserves a synchronous factory failure after an early close callback", async () => {
    const { client, closed } = clientFixture();
    const failure = new Error("Fixture synchronous factory failure");
    const manager = new ExecutorManager({ startClient: onCreated => {
      onCreated(client);
      closed();
      throw failure;
    } });
    try {
      await expect(manager.start()).rejects.toBe(failure);
      expect(manager.state()).toBe("EXECUTOR_FAILED");
      expect(client.closes).toBe(1);
    } finally { await manager.close(); }
  });

  it.each(["factory", "tools"] as const)("rejects unexpected close during a noncooperative %s after shared cleanup", async stage => {
    const { client, closed } = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const listing = Promise.withResolvers<ExecutorTool[]>();
    const entered = Promise.withResolvers<void>();
    const closeEntered = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    client.close = () => { client.closes++; closeEntered.resolve(); return drained.promise; };
    if (stage === "tools") client.listTools = () => { entered.resolve(); return listing.promise; };
    const manager = new ExecutorManager({ startClient: onCreated => {
      onCreated(client);
      if (stage === "factory") { entered.resolve(); return factory.promise; }
      return Promise.resolve(client);
    } });
    let settled = false;
    const outcome = manager.start().then(
      () => ({ error: undefined }), (error: unknown) => ({ error }),
    ).finally(() => { settled = true; });
    await entered.promise;
    closed();
    const stopping = manager.close();
    try {
      await closeEntered.promise;
      expect(settled).toBe(false);
      expect(client.closes).toBe(1);
      drained.resolve();
      await stopping;
      expect((await outcome).error).toBeInstanceOf(Error);
      expect(manager.state()).toBe("OFFLINE");
      expect(client.closes).toBe(1);
      factory.resolve(client);
      listing.resolve([{ name: "read_file" }]);
      await turn();
      expect(manager.state()).toBe("OFFLINE");
    } finally {
      drained.resolve();
      factory.resolve(client);
      listing.resolve([{ name: "read_file" }]);
      await outcome;
      await stopping;
      await manager.close();
    }
  });

  it.each(["factory", "tools"] as const)("keeps the %s failure when its state observer requests close", async stage => {
    const { client } = clientFixture();
    const failure = new Error("Fixture failure before deliberate stop");
    if (stage === "tools") client.listTools = async () => { throw failure; };
    let stopping: Promise<void> | undefined;
    const manager = new ExecutorManager({
      onState: state => { if (state === "EXECUTOR_FAILED") stopping = manager.close(); },
      startClient: async onCreated => {
        onCreated(client);
        if (stage === "factory") throw failure;
        return client;
      },
    });
    try {
      await expect(manager.start()).rejects.toBe(failure);
      await stopping;
      expect(manager.state()).toBe("OFFLINE");
      expect(client.closes).toBe(1);
    } finally { await manager.close(); }
  });

  it("records a factory rejection before another rejection observer requests close", async () => {
    const { client } = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error("Fixture source rejection before close");
    const manager = new ExecutorManager({ startClient: onCreated => {
      onCreated(client);
      entered.resolve();
      return factory.promise;
    } });
    const outcome = manager.start().then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await entered.promise;
    const stopping = factory.promise.catch(() => manager.close());
    factory.reject(failure);
    try {
      expect((await outcome).error).toBe(failure);
      await stopping;
      expect(manager.state()).toBe("OFFLINE");
      expect(client.closes).toBe(1);
    } finally { await stopping; await manager.close(); }
  });

  it.each(["close", "restart", "incompatible"] as const)("keeps %s cancellation intentional when the old factory later closes and rejects", async action => {
    const old = clientFixture();
    const next = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    let starts = 0;
    const manager = new ExecutorManager({ startClient: onCreated => {
      if (++starts === 1) { onCreated(old.client); entered.resolve(); return factory.promise; }
      onCreated(next.client);
      return Promise.resolve(next.client);
    } });
    const outcome = manager.start().then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await entered.promise;
    const invalidated = action === "incompatible" ? Promise.resolve(manager.markIncompatible()) : manager[action]();
    old.closed();
    factory.reject(new Error("Fixture factory rejected after cancellation"));
    try {
      await invalidated;
      expect((await outcome).error).toBeUndefined();
      expect(manager.state()).toBe(action === "restart" ? "READY" : action === "close" ? "OFFLINE" : "INCOMPATIBLE");
      expect(starts).toBe(action === "restart" ? 2 : 1);
      expect(old.client.closes).toBe(1);
      expect(next.client.closes).toBe(0);
    } finally { await outcome; await manager.close(); }
  });

  it("ignores the old factory's rejection and close after replacement reaches READY", async () => {
    const old = clientFixture();
    const next = clientFixture();
    const factory = Promise.withResolvers<ExecutorClient>();
    const entered = Promise.withResolvers<void>();
    let starts = 0;
    const manager = new ExecutorManager({ startClient: onCreated => {
      if (++starts === 1) { onCreated(old.client); entered.resolve(); return factory.promise; }
      return Promise.resolve(next.client);
    } });
    const starting = manager.start();
    await entered.promise;
    try {
      await manager.restart();
      await starting;
      factory.reject(new Error("Fixture stale startup failure"));
      old.closed();
      await turn();
      expect(manager.state()).toBe("READY");
      await expect(manager.callTool("read_file", {})).resolves.toEqual({ content: [] });
      expect(old.client.closes).toBe(1);
      expect(next.client.closes).toBe(0);
      expect(starts).toBe(2);
    } finally {
      factory.reject(new Error("Fixture stale startup failure"));
      await starting;
      await manager.close();
    }
  });

  it("retains the startup cause and shutdown fence when failure cleanup rejects", async () => {
    const { client, closed } = clientFixture();
    const startupError = new Error("Fixture listTools failure");
    const cleanupError = new Error("Fixture shutdown unconfirmed");
    client.listTools = async () => { throw startupError; };
    let failCleanup = true;
    client.close = async () => { client.closes++; closed(); if (failCleanup) throw cleanupError; };
    let starts = 0;
    const manager = new ExecutorManager({ startClient: async () => { starts++; return client; } });
    try {
      const failure = await manager.start().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = failure as AggregateError;
      expect(aggregate.errors[0]).toBe(startupError);
      expect(aggregate.errors[1]).toMatchObject({ cause: cleanupError });
      expect(manager.state()).toBe("EXECUTOR_FAILED");
      await expect(manager.start()).rejects.toThrow(/shutdown/i);
      await expect(manager.restart()).rejects.toThrow(/shutdown/i);
      expect({ starts, closes: client.closes }).toEqual({ starts: 1, closes: 1 });
      failCleanup = false;
      await manager.close();
      expect(client.closes).toBe(2);
    } finally { failCleanup = false; await manager.close(); }
  });
});
