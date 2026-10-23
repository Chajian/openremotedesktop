import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OperationCallMessage } from "@open-desktop-remote/protocol";
import { OperationCoordinator, OperationStore } from "./operation-store.js";
import { OperationQuery } from "./operation-query.js";

const deviceId = randomUUID();
const bootId = randomUUID();
function call(overrides: Partial<OperationCallMessage> = {}): OperationCallMessage {
  return { type: "operation.call", protocolVersion: 1, deviceId, bootId,
    requestId: randomUUID(), toolName: "write_file", arguments: { a: 1, nested: { b: 2, a: 1 } }, expiresAt: 61_000, ...overrides };
}
function setup(options: Partial<ConstructorParameters<typeof OperationStore>[0]> = {}) {
  let time = 1_000;
  let effects = 0;
  let finish!: (value: unknown) => void;
  const store = new OperationStore({ deviceId, bootId, now: () => time, ...options });
  const coordinator = new OperationCoordinator({ callTool: async () => {
    effects++;
    return new Promise((resolve) => { finish = resolve; });
  } }, store);
  return { store, coordinator, advance: (n: number) => { time = n; },
    effects: () => effects, finish: (value: unknown = { content: [{ type: "text", text: "original" }] }) => finish(value) };
}

describe("operation recovery records", () => {
  it("queries original completion repeatedly with one effect and metadata-only reads", async () => {
    const s = setup();
    const message = call();
    const pending = s.coordinator.handle(message);
    await Promise.resolve();
    expect(s.store.read(message.requestId, bootId, true)).toMatchObject({ state: "running", cancelRequested: false });
    s.finish();
    const response = await pending;
    const query = new OperationQuery(s.store);
    const request = { type: "operation.query" as const, protocolVersion: 1 as const, deviceId, bootId, queryId: randomUUID(), requestId: message.requestId, includeResult: true };
    expect(query.handle(request)).toMatchObject({ bootId, snapshot: { state: "completed", outcome: "success", payload: { status: "available", response } } });
    expect(query.handle({ ...request, includeResult: false }).snapshot).toMatchObject({ payload: { status: "available" } });
    expect(JSON.stringify(query.handle({ ...request, includeResult: false }))).not.toContain("original");
    expect(await s.coordinator.handle({ ...message, arguments: { nested: { a: 1, b: 2 }, a: 1 } })).toEqual(response);
    expect(s.effects()).toBe(1);
  });

  it.each(["arguments", "toolName", "expiresAt", "deviceId", "bootId"] as const)("rejects changed %s for a known ID without executing", async (field) => {
    const s = setup(); const message = call(); const pending = s.coordinator.handle(message);
    await Promise.resolve();
    const value = field === "arguments" ? { a: 9 } : field === "expiresAt" ? message.expiresAt + 1 : field === "toolName" ? "delete_file" : randomUUID();
    expect(await s.coordinator.handle({ ...message, [field]: value })).toMatchObject({ type: "tool.error", error: { details: { reason: "OPERATION_CONFLICT" } } });
    expect(s.effects()).toBe(1); s.finish(); await pending;
  });

  it.each([
    [{ bootId: randomUUID() }, "BOOT_MISMATCH"],
    [{ deviceId: randomUUID() }, "DEVICE_MISMATCH"],
    [{ expiresAt: 1_000 }, "SUBMISSION_EXPIRED"],
    [{ expiresAt: 301_001 }, "SUBMISSION_TOO_FAR_IN_FUTURE"],
  ] as const)("rejects invalid admission %s before execution", async (change, reason) => {
    const s = setup();
    expect(await s.coordinator.handle(call(change))).toMatchObject({ type: "tool.error", error: { details: { reason } } });
    expect(s.effects()).toBe(0);
  });

  it("clamps backwards clock and never replays after metadata cleanup", async () => {
    const s = setup({ retentionMs: 10 }); const message = call({ expiresAt: 1_010 });
    const pending = s.coordinator.handle(message); await Promise.resolve(); s.finish(); await pending;
    s.advance(1_011); expect(s.store.read(message.requestId, bootId, true)).toEqual({ state: "not_found" });
    s.advance(0);
    expect(await s.coordinator.handle(message)).toMatchObject({ error: { details: { reason: "SUBMISSION_EXPIRED" } } });
    expect(s.effects()).toBe(1);
  });

  it("bounds in-flight work and metadata without evicting running operations", async () => {
    const s = setup({ maxInFlight: 1, maxEntries: 1, retentionMs: 10 });
    const message = call({ expiresAt: 1_005 }); const pending = s.coordinator.handle(message); await Promise.resolve();
    expect(await s.coordinator.handle(call())).toMatchObject({ error: { details: { reason: "IN_FLIGHT_CAPACITY" } } });
    s.advance(1_006); expect(s.store.read(message.requestId, bootId, false).state).toBe("running");
    s.finish(); await pending;
    expect(await s.coordinator.handle(call())).toMatchObject({ error: { details: { reason: "METADATA_CAPACITY" } } });
    s.advance(1_017);
    const next = s.coordinator.handle(call()); await Promise.resolve(); s.finish(); await next;
    expect(s.effects()).toBe(2);
  });

  it("expires payloads without extending TTL on reads or deleting unexpired intent metadata", async () => {
    const s = setup({ retentionMs: 10 }); const message = call(); const pending = s.coordinator.handle(message);
    await Promise.resolve(); s.finish(); await pending;
    s.advance(1_009); expect(s.store.read(message.requestId, bootId, true)).toMatchObject({ payload: { status: "available" } });
    s.advance(1_010); expect(s.store.read(message.requestId, bootId, true)).toMatchObject({ state: "completed", payload: { status: "expired" } });
    expect(await s.coordinator.handle(message)).toMatchObject({ error: { code: "EXECUTION_UNKNOWN" } });
    expect(s.effects()).toBe(1);
  });

  it("evicts result bodies under byte pressure while preserving terminal evidence", async () => {
    const s = setup({ maxCachedBytes: 450 }); const one = call(); const p1 = s.coordinator.handle(one);
    await Promise.resolve(); s.finish({ text: "x".repeat(110) }); await p1;
    const two = call(); const p2 = s.coordinator.handle(two); await Promise.resolve(); s.finish({ text: "y".repeat(110) }); await p2;
    expect(s.store.read(one.requestId, bootId, true)).toMatchObject({ state: "completed", outcome: "success", payload: { status: "evicted" } });
    expect(s.store.read(two.requestId, bootId, true)).toMatchObject({ payload: { status: "available" } });
  });

  it("records cancellation independently of a genuine completed isError result", async () => {
    const s = setup(); const message = call(); const pending = s.coordinator.handle(message); await Promise.resolve();
    s.coordinator.cancel(message.requestId); const raw = { isError: true, content: [{ type: "text", text: "tool failure" }] };
    s.finish(raw); expect(await pending).toMatchObject({ type: "tool.result", result: raw });
    s.coordinator.cancel(message.requestId);
    expect(s.store.read(message.requestId, bootId, true)).toMatchObject({ state: "completed", cancelRequested: true, outcome: "error" });
  });

  it("preserves successful completion when cancellation arrives before or after the result", async () => {
    const s = setup(); const message = call(); const pending = s.coordinator.handle(message); await Promise.resolve();
    s.coordinator.cancel(message.requestId); s.finish(); const response = await pending;
    s.coordinator.cancel(message.requestId);
    expect(s.store.read(message.requestId, bootId, true)).toMatchObject({
      state: "completed", cancelRequested: true, outcome: "success", payload: { status: "available", response },
    });
    expect(await s.coordinator.handle(message)).toEqual(response); expect(s.effects()).toBe(1);
  });

  it.each(["size", "serialization", "throw"])("treats %s failure after execution as unknown evidence", async (kind) => {
    const store = new OperationStore({ deviceId, bootId, now: () => 1_000, maxResultBytes: 400 });
    const coordinator = new OperationCoordinator({ async callTool() {
      if (kind === "throw") throw new Error("private tool output");
      if (kind === "size") return { text: "x".repeat(500) };
      const circular: Record<string, unknown> = {}; circular.self = circular; return circular;
    } }, store);
    const message = call(); const response = await coordinator.handle(message);
    expect(response).toMatchObject({ type: "tool.error" });
    expect(JSON.stringify(response)).not.toContain("private tool output");
    expect(store.read(message.requestId, bootId, true)).toMatchObject({ state: "completed", outcome: "unknown" });
  });

  it("marks running observations unknown on executor replacement and ignores stale completion", async () => {
    const s = setup(); const done = call(); const first = s.coordinator.handle(done); await Promise.resolve(); s.finish(); await first;
    const running = call(); const pending = s.coordinator.handle(running); await Promise.resolve();
    s.coordinator.invalidateRunning(); expect(await pending).toMatchObject({ error: { code: "EXECUTION_UNKNOWN" } });
    s.finish({ text: "stale completion" }); await Promise.resolve(); await Promise.resolve();
    expect(s.store.read(running.requestId, bootId, true)).toMatchObject({ state: "completed", outcome: "unknown" });
    expect(s.store.read(done.requestId, bootId, true)).toMatchObject({ outcome: "success" });
  });

  it("read-only query distinguishes missing and restarted without an execution dependency", () => {
    const reads: unknown[] = [];
    const query = new OperationQuery({ deviceId, bootId, read(id, expected, include) { reads.push([id, expected, include]); return { state: "not_found" }; } });
    const request = { type: "operation.query" as const, protocolVersion: 1 as const, deviceId, bootId, requestId: randomUUID(), queryId: randomUUID(), includeResult: false };
    expect(query.handle(request)).toMatchObject({ snapshot: { state: "not_found" } });
    expect(reads).toEqual([[request.requestId, bootId, false]]);
    expect(setup().store.read(request.requestId, randomUUID(), true)).toEqual({ state: "restarted" });
    expect(() => query.handle({ ...request, deviceId: randomUUID() })).toThrow("device");
  });
});

it("does not dispatch an admitted operation after its executor was invalidated before execution", async () => {
  let effects = 0;
  const store = new OperationStore({ deviceId, bootId, now: () => 1_000 });
  const coordinator = new OperationCoordinator({ async callTool() { effects++; return {}; } }, store);
  const pending = coordinator.handle(call()); coordinator.invalidateRunning(); await pending;
  await Promise.resolve(); expect(effects).toBe(0);
});

it("starts bounded recovery for a hung execution, retains unknown evidence and admits new work without replay", async () => {
  vi.useFakeTimers();
  try {
    let restarts = 0;
    let effects = 0;
    const store = new OperationStore({ deviceId, bootId, now: () => 1000, maxInFlight: 1 });
    let coordinator!: OperationCoordinator;
    const executor = { callTool: async () => {
      effects++;
      if (effects === 1) return new Promise(() => undefined);
      return { content: [{ type: "text", text: "second" }] };
    } };
    coordinator = new OperationCoordinator(executor, store, {
      maxExecutionMs: 50,
      recoverExecutor: async () => { restarts++; coordinator.invalidateRunning(); },
    });
    const message = call();
    const first = coordinator.handle(message);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(await first).toMatchObject({ error: { code: "EXECUTION_UNKNOWN" } });
    expect(store.read(message.requestId, bootId, false)).toMatchObject({ state: "completed", outcome: "unknown" });
    expect(restarts).toBe(1);
    const second = await coordinator.handle(call());
    expect(second.type).toBe("tool.result");
    expect(effects).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("clears a completed operation watchdog without restarting the executor", async () => {
  vi.useFakeTimers();
  try {
    let restarts = 0;
    const store = new OperationStore({ deviceId, bootId, now: () => 1000 });
    const coordinator = new OperationCoordinator({ callTool: async () => ({ content: [] }) }, store, {
      maxExecutionMs: 50,
      recoverExecutor: async () => { restarts++; },
    });
    expect((await coordinator.handle(call())).type).toBe("tool.result");
    await vi.advanceTimersByTimeAsync(100);
    expect(restarts).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
