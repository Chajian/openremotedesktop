import { expect, it, vi } from "vitest";

const connect = vi.hoisted(() => vi.fn());
vi.mock("./runtime.js", () => ({ runAgentConnect: connect }));

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
