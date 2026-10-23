import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/database.js";
import { DeviceRepository } from "../devices/device-repository.js";
import { ConnectionRegistry } from "../relay/connection-registry.js";
import { RequestBroker } from "../relay/request-broker.js";
import { OperationRepository } from "./operation-repository.js";
import { OwnedOperationAccessPolicy } from "./access-policy.js";
import { OperationService } from "./operation-service.js";
const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); while (cleanups.length)
  cleanups.pop()!(); });
class Socket {
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { }
  terminate() { }
}
function fixture(recovery = true, clock?: () => number, maxPendingCalls?: number) {
  const dir = mkdtempSync(join(tmpdir(), "odr-operations-"));
  const path = join(dir, "db.sqlite");
  const db = createDatabase(path);
  db.prepare("INSERT INTO owner (id,password_hash,created_at) VALUES ('owner','disabled',0)").run();
  const devices = new DeviceRepository(db);
  const device = devices.create("Test device", "owner");
  const registry = new ConnectionRegistry();
  const socket = new Socket();
  const connection = registry.attach(device.id, socket as never);
  registry.markAuthenticated(device.id, socket as never);
  registry.markExecutorState(device.id, socket as never, "EXECUTOR_STARTING");
  registry.markExecutorState(device.id, socket as never, "READY");
  if (recovery)
    connection.bootId = randomUUID();
  const broker = new RequestBroker(registry, maxPendingCalls === undefined ? {} : { maxPendingCalls });
  const repository = new OperationRepository(db);
  const logger = {event: vi.fn()};
  const service = new OperationService(repository, broker, new OwnedOperationAccessPolicy(devices), {
    ...(clock ? { now: clock } : {}), logger,
  });
  let authorized = true;
  const actor = { userId: "owner", clientId: "client", authorize: async () => authorized };
  const response = (requestId: string, text = "private-result-marker") => ({ type: "tool.result" as const, protocolVersion: 1 as const, deviceId: device.id, requestId, result: { content: [{ type: "text", text }] } });
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, path, devices, device, registry, socket, connection, broker, repository, service, logger, actor, response, revoke: () => { authorized = false; } };
}
async function dispatched(f: ReturnType<typeof fixture>) {
  const pending = f.service.invoke(f.actor, f.device.id, "write_file", { path: "private-args-marker" }, { timeoutMs: 20 });
  // Authorization is deliberately asynchronous; wait for dispatch without a timer.
  for (let i = 0; i < 10 && !f.socket.sent.length; i++)
    await Promise.resolve();
  return { pending, call: f.socket.sent[0]! };
}
describe("operation service", () => {
  it("dispatches exactly once with stable ID/deadline; disconnect exposes ID; late result persists metadata only", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    const failure = expect(pending).rejects.toMatchObject({ code: "EXECUTION_UNKNOWN", details: { operationId: call.requestId } });
    expect(f.logger.event).toHaveBeenCalledWith("operation.dispatch",
      expect.objectContaining({ operationId: call.requestId, deviceId: f.device.id }));
    expect(call).toMatchObject({ type: "operation.call", bootId: f.connection.bootId });
    expect(call.expiresAt - Date.now()).toBeGreaterThan(59000);
    f.broker.handleDisconnect(f.device.id, f.socket as never);
    await failure;
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    expect(f.repository.find(call.requestId)).toMatchObject({ phase: "completed", outcome: "success" });
    expect(f.socket.sent).toHaveLength(1);
    f.db.pragma("wal_checkpoint(TRUNCATE)");
    expect(readFileSync(f.path).includes(Buffer.from("private-result-marker"))).toBe(false);
    expect(readFileSync(f.path).includes(Buffer.from("private-args-marker"))).toBe(false);
    const reopened = createDatabase(f.path);
    expect(new OperationRepository(reopened).find(call.requestId)).toMatchObject({ phase: "completed" });
    reopened.close();
  });
  it("retains first terminal digest and flags conflicting evidence without replacing outcome", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    await pending;
    const before = f.repository.find(call.requestId)!;
    f.broker.handleMessage(f.response(call.requestId, "conflicting"), f.socket as never);
    expect(f.repository.find(call.requestId)).toMatchObject({ terminalDigest: before.terminalDigest, conflict: true, outcome: "success" });
  });
  it("rejects foreign socket and wrong boot evidence even after waiter timeout", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", details: { operationId: call.requestId } });
    const other = new Socket();
    f.broker.handleMessage(f.response(call.requestId), other as never);
    expect(f.repository.find(call.requestId)?.phase).toBe("unknown");
    const replacement = f.registry.attach(f.device.id, other as never);
    f.registry.markAuthenticated(f.device.id, other as never);
    replacement.bootId = randomUUID();
    f.broker.handleMessage(f.response(call.requestId), other as never);
    expect(f.repository.find(call.requestId)?.phase).toBe("unknown");
  });
  it("uses legacy calls before negotiation and preserves original results", async () => {
    const f = fixture(false);
    const { pending, call } = await dispatched(f);
    expect(call.type).toBe("tool.call");
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    await expect(pending).resolves.toEqual(f.response(call.requestId));
  });
  it("makes missing/cross-user/cross-client/revoked queries indistinguishable without dispatch", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    await pending;
    const missing = await f.service.query(f.actor, randomUUID());
    expect(await f.service.query({ ...f.actor, userId: "other" }, call.requestId)).toEqual(missing);
    expect(await f.service.query({ ...f.actor, clientId: "other" }, call.requestId)).toEqual(missing);
    f.revoke();
    expect(await f.service.query(f.actor, call.requestId)).toEqual(missing);
    expect(f.socket.sent).toHaveLength(1);
  });
  it("rechecks authorization before original result delivery", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    f.revoke();
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    await expect(pending).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
  });
  it("queries cached result read-only and rechecks ownership before delivery", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    const query = f.service.query(f.actor, call.requestId);
    for (let i = 0; i < 10 && f.socket.sent.length < 2; i++)
      await Promise.resolve();
    const frame = f.socket.sent[1]!;
    expect(frame).toMatchObject({ type: "operation.query", requestId: call.requestId, includeResult: true });
    f.devices.revokeDevice(f.device.id);
    f.broker.handleStatus({ ...frame, type: "operation.status", snapshot: { state: "completed", completedAt: Date.now(), cancelRequested: false, outcome: "success", payload: { status: "available", response: f.response(call.requestId) } } }, f.socket as never);
    expect(await query).toEqual({ state: "not_found" });
    expect(f.socket.sent.filter(x => x.type === "operation.call")).toHaveLength(1);
  });
  it("returns offline and restarted availability without regressing terminal evidence", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    await pending;
    f.registry.detach(f.device.id, f.socket as never);
    expect(await f.service.query(f.actor, call.requestId)).toMatchObject({ phase: "completed", outcome: "success", resultAvailability: "offline" });
    const socket = new Socket();
    const conn = f.registry.attach(f.device.id, socket as never);
    f.registry.markAuthenticated(f.device.id, socket as never);
    conn.bootId = randomUUID();
    expect(await f.service.query(f.actor, call.requestId)).toMatchObject({ phase: "completed", outcome: "success", resultAvailability: "restarted" });
    expect(socket.sent).toHaveLength(0);
  });
  it("cleans metadata after 24 hours using an expiry index without dispatch", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    await pending;
    expect(f.repository.cleanup(Date.now() + 86400001)).toBe(1);
    expect(f.repository.find(call.requestId)).toBeNull();
    expect(f.db.prepare("EXPLAIN QUERY PLAN DELETE FROM operations WHERE retention_until <= ?").all(Date.now())).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining("idx_operations_retention") })]));
  });
});
describe("operation evidence and read-only availability", () => {
  it.each(["expired", "evicted", "unavailable"] as const)("retains terminal metadata for %s bodies and never executes again", async (availability) => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    const query = f.service.query(f.actor, call.requestId, false);
    for (let i = 0; i < 10 && f.socket.sent.length < 2; i++)
      await Promise.resolve();
    const frame = f.socket.sent[1]!;
    f.broker.handleStatus({ ...frame, type: "operation.status", snapshot: { state: "completed", completedAt: 42, cancelRequested: false, outcome: "error", payload: { status: availability } } }, f.socket as never);
    expect(await query).toMatchObject({ phase: "completed", outcome: "error", resultAvailability: availability });
    expect(f.socket.sent.filter(x => x.type === "operation.call")).toHaveLength(1);
  });
  it("retains original terminal evidence when a later query reports not_found", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    await pending;
    const query = f.service.query(f.actor, call.requestId);
    for (let i = 0; i < 10 && f.socket.sent.length < 2; i++)
      await Promise.resolve();
    const frame = f.socket.sent[1]!;
    f.broker.handleStatus({ ...frame, type: "operation.status", snapshot: { state: "not_found" } }, f.socket as never);
    expect(await query).toMatchObject({ phase: "completed", outcome: "success", resultAvailability: "not_found" });
  });
  it("returns a recovered original body with one execution after same-boot reconnect", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    const failure = expect(pending).rejects.toMatchObject({ code: "EXECUTION_UNKNOWN" });
    f.broker.handleDisconnect(f.device.id, f.socket as never);
    await failure;
    const socket = new Socket();
    const conn = f.registry.attach(f.device.id, socket as never);
    f.registry.markAuthenticated(f.device.id, socket as never);
    conn.bootId = f.connection.bootId!;
    const query = f.service.query(f.actor, call.requestId);
    for (let i = 0; i < 10 && !socket.sent.length; i++)
      await Promise.resolve();
    const frame = socket.sent[0]!;
    f.broker.handleStatus({ ...frame, type: "operation.status", snapshot: { state: "completed", completedAt: 123, cancelRequested: false, outcome: "success", payload: { status: "available", response: f.response(call.requestId) } } }, socket as never);
    expect(await query).toMatchObject({ phase: "completed", outcome: "success", snapshot: { payload: { response: f.response(call.requestId) } } });
    expect(socket.sent.map(x => x.type)).toEqual(["operation.query"]);
  });
  it("records cancellation independently and accepts actual late completion", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    f.broker.cancel(call.requestId);
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    expect(f.repository.find(call.requestId)).toMatchObject({ phase: "completed", outcome: "success", cancelRequested: true });
  });
  it("does not weaken known terminal metadata on unknown observations", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    f.broker.handleMessage(f.response(call.requestId), f.socket as never);
    await pending;
    f.repository.terminal(call.requestId, "unknown", Date.now(), null, Date.now());
    expect(f.repository.find(call.requestId)).toMatchObject({ outcome: "success", conflict: false });
  });
  it("treats throwing dispatch as ambiguous because the effect may have started", async () => {
    const f = fixture();
    f.connection.send = () => { throw new Error("network failure"); };
    await expect(f.service.invoke(f.actor, f.device.id, "write_file", {}, { timeoutMs: 10 })).rejects.toMatchObject({ code: "EXECUTION_UNKNOWN", details: { operationId: expect.any(String) } });
  });
  it("never dispatches when current ownership changed or device is revoked", async () => {
    const f = fixture();
    f.devices.revokeDevice(f.device.id);
    await expect(f.service.invoke(f.actor, f.device.id, "read_file", {}, { timeoutMs: 10 })).rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
    expect(f.socket.sent).toHaveLength(0);
  });
});
it("records running cancellation evidence without converting it to terminal completion", async () => {
  const f = fixture();
  const { pending, call } = await dispatched(f);
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  const query = f.service.query(f.actor, call.requestId);
  for (let i = 0; i < 10 && f.socket.sent.length < 2; i++)
    await Promise.resolve();
  const frame = f.socket.sent[1]!;
  f.broker.handleStatus({ ...frame, type: "operation.status", snapshot: { state: "running", startedAt: 1, cancelRequested: true } }, f.socket as never);
  expect(await query).toMatchObject({ phase: "unknown", cancelRequested: true, resultAvailability: "running" });
});


it("prunes legacy socket correlations at metadata expiry on a long-lived connection", async () => {
  let now = 1;
  const f = fixture(false, () => now);
  const first = await dispatched(f);
  f.broker.handleMessage(f.response(first.call.requestId), f.socket as never);
  await first.pending;
  const correlations = Reflect.get(f.service, "legacySockets") as WeakMap<object, Map<string, number>>;
  expect(correlations.get(f.socket)?.size).toBe(1);
  now += 86_400_001;
  const pending = f.service.invoke(f.actor, f.device.id, "read_file", {}, { timeoutMs: 100 });
  for (let i = 0; i < 10 && f.socket.sent.length < 2; i++) await Promise.resolve();
  const call = f.socket.sent[1]!;
  f.broker.handleMessage(f.response(call.requestId), f.socket as never);
  await pending;
  expect(correlations.get(f.socket)?.size).toBe(1);
  expect(correlations.get(f.socket)?.has(first.call.requestId)).toBe(false);
});

it("does not misreport persistence errors during query as an offline device", async () => {
  const f = fixture();
  const { pending, call } = await dispatched(f);
  f.broker.handleMessage(f.response(call.requestId), f.socket as never);
  await pending;
  const query = f.service.query(f.actor, call.requestId);
  const failure = expect(query).rejects.toThrow("persistence unavailable");
  for (let i = 0; i < 10 && f.socket.sent.length < 2; i++) await Promise.resolve();
  const frame = f.socket.sent[1]!;
  vi.spyOn(f.repository, "terminal").mockImplementation(() => { throw new Error("persistence unavailable"); });
  f.broker.handleStatus({ ...frame, type: "operation.status", snapshot: { state: "completed", completedAt: 1, cancelRequested: false, outcome: "success", payload: { status: "expired" } } }, f.socket as never);
  await failure;
});

it("reconciles a running query snapshot with completion during the final authorization await", async () => {
  const f = fixture();
  const { pending, call } = await dispatched(f);
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  let checks = 0;
  let releaseAuthorization!: (value: boolean) => void;
  const authorization = new Promise<boolean>((resolve) => { releaseAuthorization = resolve; });
  const actor = {
    ...f.actor,
    authorize: async () => ++checks === 2 ? authorization : true,
  };
  const query = f.service.query(actor, call.requestId);
  for (let i = 0; i < 10 && f.socket.sent.length < 2; i++) await Promise.resolve();
  const frame = f.socket.sent[1]!;
  f.broker.handleStatus({
    ...frame,
    type: "operation.status",
    snapshot: { state: "running", startedAt: 1, cancelRequested: true },
  }, f.socket as never);
  for (let i = 0; i < 10 && checks < 2; i++) await Promise.resolve();
  expect(checks).toBe(2);
  f.broker.handleMessage(f.response(call.requestId), f.socket as never);
  releaseAuthorization(true);
  const result = await query;
  expect(result).toMatchObject({
    phase: "completed", outcome: "success", cancelRequested: true,
    resultAvailability: "unavailable",
  });
  expect(result).not.toHaveProperty("snapshot");
});

describe("review follow-up: safe dispatch and persistence failures", () => {
  it("does not retain an unknown executable operation when the broker rejected capacity before dispatch", async () => {
    const f = fixture(true, undefined, 0);
    const error = await f.service.invoke(f.actor, f.device.id, "write_file", {}, { timeoutMs: 20 }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "REQUEST_TIMEOUT", details: { reason: "capacity", dispatched: false } });
    expect(f.socket.sent).toHaveLength(0);
    expect(f.logger.event).not.toHaveBeenCalledWith("operation.dispatch", expect.anything());
    expect(error).not.toHaveProperty("details.operationId");
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM operations").get()).toMatchObject({ count: 0 });
  });

  it("delivers an authenticated matching result despite a failed metadata write without treating it as a protocol error", async () => {
    const f = fixture();
    const { pending, call } = await dispatched(f);
    vi.spyOn(f.repository, "terminal").mockImplementation(() => { throw new Error("SQLITE_BUSY"); });
    expect(() => f.broker.handleMessage(f.response(call.requestId), f.socket as never)).not.toThrow();
    await expect(pending).resolves.toEqual(f.response(call.requestId));
  });
});
