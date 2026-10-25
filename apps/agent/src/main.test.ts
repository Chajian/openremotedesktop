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
