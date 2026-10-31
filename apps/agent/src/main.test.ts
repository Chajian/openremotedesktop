import { expect, it, vi } from "vitest";

const connect = vi.hoisted(() => vi.fn());
vi.mock("./runtime.js", () => ({ runAgentConnect: connect }));

it.each(["SIGINT", "SIGTERM"] as const)("keeps handling %s until asynchronous shutdown finishes", async (signal) => {
  const argv = process.argv;
  const listeners = new Set(process.listeners(signal));
  const started = Promise.withResolvers<AbortSignal>();
  const cleanup = Promise.withResolvers<void>();
  let main: Promise<unknown> | undefined;
  try {
    vi.resetModules();
    process.argv = [process.execPath, "agent", "agent", "connect", "--server", "https://remote.example.com"];
    connect.mockImplementationOnce(async (_url: URL, abort: AbortSignal) => {
      started.resolve(abort);
      await cleanup.promise;
    });
    main = import("./main.js");
    const abort = await started.promise;
    const stop = process.listeners(signal).find(listener => !listeners.has(listener))!;
    expect(stop).toBeDefined();
    const onAbort = vi.fn();
    abort.addEventListener("abort", onAbort);
    // EventEmitter emission checks listener lifetime without terminating Vitest.
    process.emit(signal);
    expect(abort.aborted).toBe(true);
    expect(process.listeners(signal)).toContain(stop);
    process.emit(signal);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(process.listeners(signal)).toContain(stop);
  } finally {
    cleanup.resolve();
    await main;
    process.argv = argv;
  }
  expect(new Set(process.listeners(signal))).toEqual(listeners);
});

it.each(["aggregate", "single"])("reports %s shutdown failure without printing nested exception payloads", async (kind) => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const signals = ["SIGINT", "SIGTERM"] as const;
  const listeners = signals.map(signal => new Set(process.listeners(signal)));
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    vi.resetModules();
    process.argv = [process.execPath, "agent", "agent", "connect", "--server", "https://remote.example.com"];
    connect.mockRejectedValueOnce(kind === "aggregate" ? new AggregateError([
      new Error("fixture private tool output"),
      new Error("fixture private subprocess diagnostics"),
    ], "Agent failed and executor shutdown could not be confirmed") : new Error(
      "Previous executor shutdown could not be confirmed", { cause: new Error("fixture private subprocess diagnostics") },
    ));

    await expect(import("./main.js")).resolves.toBeDefined();
    expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls).toEqual([[kind === "aggregate"
      ? "Agent stopped after an initialization or shutdown failure. Subprocess shutdown could not be confirmed."
      : "Agent connection failed. Check device authorization, network, and the packaged executor."]]);
    for (const [index, signal] of signals.entries()) {
      expect(new Set(process.listeners(signal))).toEqual(listeners[index]);
    }
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    stderr.mockRestore();
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!listeners[index]!.has(listener)) process.removeListener(signal, listener);
      }
    }
  }
});

it("reports a malformed refresh response distinctly without exposing credentials or the response body", async () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const signals = ["SIGINT", "SIGTERM"] as const;
  const listeners = signals.map(signal => new Set(process.listeners(signal)));
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    vi.resetModules();
    const { ServerClient } = await import("./http/server-client.js");
    const client = new ServerClient(new URL("https://remote.example.com"), async () => new Response(
      '{"accessToken":"fixture-private-body","expiresAt":"invalid","deviceId":"fixture-device"}',
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const failure = await client.refreshDeviceAccess("fixture-private-refresh").then(
      () => new Error("Malformed response was accepted"), (error: unknown) => error,
    );
    connect.mockRejectedValueOnce(failure);
    process.argv = [process.execPath, "agent", "agent", "connect", "--server", "https://remote.example.com"];
    await expect(import("./main.js")).resolves.toBeDefined();
    expect(process.exitCode).toBe(1);
    const diagnostic = JSON.stringify(stderr.mock.calls);
    expect(diagnostic).toMatch(/invalid.*response/i);
    expect(diagnostic).not.toMatch(/pair.*again|fixture-private|accessToken/);
    for (const [index, signal] of signals.entries()) {
      expect(new Set(process.listeners(signal))).toEqual(listeners[index]);
    }
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    stderr.mockRestore();
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!listeners[index]!.has(listener)) process.removeListener(signal, listener);
      }
    }
  }
});
