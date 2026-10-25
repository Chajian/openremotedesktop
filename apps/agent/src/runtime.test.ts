import { describe, expect, it, vi } from "vitest";
import type { DeviceCredential } from "./credentials/credential-store.js";
import { runAgentConnect } from "./runtime.js";
import { ExecutorManager } from "./executor/executor-manager.js";

describe("runAgentConnect", () => {
  it("pairs/loads a credential, runs relay, and closes the executor", async () => {
    const credential: DeviceCredential = {
      serverUrl: "https://remote.example.com/",
      deviceId: "11111111-1111-4111-8111-111111111111",
      refreshCredential: "refresh-secret",
    };
    const ensureCredential = vi.fn(async () => credential);
    const close = vi.fn(async () => undefined);
    const executor = { close };
    const run = vi.fn(async (_signal: AbortSignal) => undefined);
    const createRelay = vi.fn(() => ({ run }));
    const store = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const io = { showVerification: vi.fn() };
    const signal = new AbortController().signal;

    await runAgentConnect(new URL("https://remote.example.com"), signal, {
      store,
      io,
      ensureCredential,
      createExecutor: () => executor as never,
      createRelay: createRelay as never,
    });

    expect(ensureCredential).toHaveBeenCalledWith(
      new URL("https://remote.example.com"),
      store,
      io,
      { signal },
    );
    expect(createRelay).toHaveBeenCalledWith(credential, executor);
    expect(run).toHaveBeenCalledWith(signal);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("always closes the executor when the relay run fails", async () => {
    const close = vi.fn(async () => undefined);
    const failure = new Error("relay failed");

    await expect(
      runAgentConnect(
        new URL("https://remote.example.com"),
        new AbortController().signal,
        {
          store: {
            get: async () => null,
            set: async () => undefined,
            clear: async () => undefined,
          },
          io: { showVerification: () => undefined },
          ensureCredential: async () => ({
            serverUrl: "https://remote.example.com/",
            deviceId: "11111111-1111-4111-8111-111111111111",
            refreshCredential: "refresh-secret",
          }),
          createExecutor: () => ({ close }) as never,
          createRelay: () =>
            ({
              run: async () => {
                throw failure;
              },
            }) as never,
        },
      ),
    ).rejects.toBe(failure);

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("runtime lifecycle failure paths", () => {
  const options = {
    store: { get: async () => null, set: async () => undefined, clear: async () => undefined },
    io: { showVerification: () => undefined },
    ensureCredential: async () => ({ serverUrl: "https://remote.example.com/", deviceId: "11111111-1111-4111-8111-111111111111", refreshCredential: "fixture-refresh" }),
  };

  it("does not access credentials or construct an executor when already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const ensureCredential = vi.fn(options.ensureCredential);
    const createExecutor = vi.fn(() => new ExecutorManager({ startClient: async () => { throw new Error("must not start"); } }));
    await runAgentConnect(new URL("https://remote.example.com"), controller.signal, { ...options, ensureCredential, createExecutor });
    expect(ensureCredential).not.toHaveBeenCalled();
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it("observes the same failed shutdown from abort and final cleanup without retrying", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const failedClose = new Error("fixture shutdown failure");
    const executor = new ExecutorManager({ startClient: async () => { throw new Error("must not start"); } });
    const close = vi.spyOn(executor, "close").mockRejectedValue(failedClose);
    const running = runAgentConnect(new URL("https://remote.example.com"), controller.signal, {
      ...options, createExecutor: () => executor,
      createRelay: () => ({ run: async signal => {
        entered.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => setImmediate(resolve), { once: true }));
      } }),
    });
    const result = running.catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    expect(await result).toBe(failedClose);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes an owned executor even when relay construction throws", async () => {
    let closes = 0;
    const executor = new ExecutorManager({ startClient: async () => ({
      listTools: async () => [{ name: "read_file" }],
      callTool: async () => ({}),
      close: async () => { closes++; },
    }) });
    await executor.start();
    const failure = new Error("relay construction failed");
    await expect(runAgentConnect(new URL("https://remote.example.com"), new AbortController().signal, {
      ...options, createExecutor: () => executor, createRelay: () => { throw failure; },
    })).rejects.toBe(failure);
    expect(closes).toBe(1);
  });

  it("retains both relay and shutdown errors when final cleanup also fails", async () => {
    const relayFailure = new Error("relay failed");
    const shutdownFailure = new Error("shutdown failed");
    const executor = new ExecutorManager({ startClient: async () => ({
      listTools: async () => [{ name: "read_file" }],
      callTool: async () => ({}),
      close: async () => { throw shutdownFailure; },
    }) });
    await executor.start();
    const failure = await runAgentConnect(new URL("https://remote.example.com"), new AbortController().signal, {
      ...options, createExecutor: () => executor, createRelay: () => ({ run: async () => { throw relayFailure; } }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected both failures");
    expect(failure.errors[0]).toBe(relayFailure);
    expect(failure.errors[1]).toMatchObject({ cause: shutdownFailure });
  });

  it("cleans up after an incompatibility notice has revoked readiness", async () => {
    let closes = 0;
    const executor = new ExecutorManager({ startClient: async () => ({
      listTools: async () => [{ name: "read_file" }],
      callTool: async () => ({}),
      close: async () => { closes++; },
    }) });
    await executor.start();
    await runAgentConnect(new URL("https://remote.example.com"), new AbortController().signal, {
      ...options, createExecutor: () => executor, createRelay: () => ({ run: async () => { executor.markIncompatible(); } }),
    });
    expect(closes).toBe(1);
    expect(executor.state()).toBe("OFFLINE");
  });
});
