import { describe, expect, it } from "vitest";
import {
  OPERATION_RECOVERY_CAPABILITY,
  OPERATION_RECOVERY_NOTICE,
  OperationSnapshotSchema,
  parseRelayMessage,
} from "./index.js";

const deviceId = "6d1cf056-7fc5-49d4-8930-f989aafd957b";
const requestId = "8a4e7a20-8cad-4211-a277-8e0f4438d581";
const bootId = "a7a88708-d6a8-4f28-a754-15f8781589fd";
const queryId = "7863ec66-f0e9-41cb-89da-9a7e17b24777";
const now = 1_792_627_200_000;
const result = {
  type: "tool.result",
  protocolVersion: 1,
  deviceId,
  requestId,
  result: { content: [{ type: "text", text: "original outcome" }] },
} as const;
const error = {
  type: "tool.error",
  protocolVersion: 1,
  deviceId,
  requestId,
  error: { code: "EXECUTION_UNKNOWN", message: "Outcome is uncertain" },
} as const;
const frames = [
  { type: "agent.recovery", protocolVersion: 1, deviceId, bootId },
  {
    type: "operation.call", protocolVersion: 1, deviceId, requestId, bootId,
    toolName: "read_file", arguments: { path: "example.txt" }, expiresAt: now,
  },
  {
    type: "operation.query", protocolVersion: 1, deviceId, requestId, bootId,
    queryId, includeResult: true,
  },
  {
    type: "operation.status", protocolVersion: 1, deviceId, requestId, bootId,
    queryId, snapshot: { state: "running", startedAt: now, cancelRequested: false },
  },
] as const;
const status = frames[3];
const completed = {
  state: "completed", completedAt: now, cancelRequested: false,
  outcome: "success", payload: { status: "available", response: result },
} as const;

describe("negotiated operation recovery contracts", () => {
  it("exports stable negotiation constants and a reusable snapshot schema", () => {
    expect(OPERATION_RECOVERY_CAPABILITY).toBe("operation-recovery-v1");
    expect(OPERATION_RECOVERY_NOTICE).toBe("OPERATION_RECOVERY_ENABLED");
    expect(OperationSnapshotSchema).toBeDefined();
  });

  it.each(frames)("preserves the strict $type frame", (frame) => {
    expect(parseRelayMessage(frame)).toEqual(frame);
  });

  it.each(frames)("rejects extra fields on $type", (frame) => {
    expect(() => parseRelayMessage({ ...frame, unexpected: true })).toThrow();
  });

  it.each(frames)("requires protocol version 1 on $type", (frame) => {
    expect(() => parseRelayMessage({ ...frame, protocolVersion: 2 })).toThrow();
  });

  it.each(frames)("requires valid device and boot UUIDs on $type", (frame) => {
    for (const field of ["deviceId", "bootId"]) {
      expect(() => parseRelayMessage({ ...frame, [field]: "invalid" })).toThrow();
      const missing: Record<string, unknown> = { ...frame };
      delete missing[field];
      expect(() => parseRelayMessage(missing)).toThrow();
    }
  });

  it.each(frames.slice(1))("requires the request UUID on $type", (frame) => {
    expect(() => parseRelayMessage({ ...frame, requestId: "invalid" })).toThrow();
  });

  it.each([frames[2], status])("requires a distinct query UUID field on $type", (frame) => {
    expect(() => parseRelayMessage({ ...frame, queryId: "invalid" })).toThrow();
    const { queryId: _queryId, ...missing } = frame;
    expect(() => parseRelayMessage(missing)).toThrow();
  });

  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "tomorrow", null, undefined])(
    "rejects invalid submission expiry %s", (expiresAt) => {
      expect(() => parseRelayMessage({ ...frames[1], expiresAt })).toThrow();
    },
  );

  it("leaves expiry admission and process epoch comparison to the receiver", () => {
    expect(parseRelayMessage({ ...frames[1], expiresAt: 0 })).toEqual({ ...frames[1], expiresAt: 0 });
    expect(parseRelayMessage({ ...status, snapshot: { state: "restarted" } })).toEqual({
      ...status, snapshot: { state: "restarted" },
    });
  });

  it("requires a boolean includeResult without adding a wire default", () => {
    expect(parseRelayMessage({ ...frames[2], includeResult: false })).toEqual({ ...frames[2], includeResult: false });
    for (const includeResult of [undefined, "true", 1, null]) {
      expect(() => parseRelayMessage({ ...frames[2], includeResult })).toThrow();
    }
  });

  it.each([
    { state: "not_found" },
    { state: "restarted" },
    { state: "running", startedAt: now, cancelRequested: true },
    completed,
    { ...completed, outcome: "error", payload: { status: "available", response: error } },
    { ...completed, outcome: "unknown", payload: { status: "unavailable" } },
    { ...completed, payload: { status: "available" } },
    { ...completed, payload: { status: "expired" } },
    { ...completed, payload: { status: "evicted" } },
  ])("preserves the snapshot variant %j", (snapshot) => {
    expect(OperationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(parseRelayMessage({ ...status, snapshot })).toEqual({ ...status, snapshot });
  });

  it.each([Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe snapshot timestamps %s", (timestamp) => {
    expect(() => parseRelayMessage({
      ...status, snapshot: { state: "running", startedAt: timestamp, cancelRequested: false },
    })).toThrow();
    expect(() => parseRelayMessage({ ...status, snapshot: { ...completed, completedAt: timestamp } })).toThrow();
  });

  it.each([
    { ...frames[1], toolName: "" },
    { ...frames[1], arguments: [] },
    { ...frames[1], arguments: null },
    { ...status, snapshot: undefined },
    { ...status, snapshot: { ...completed, payload: undefined } },
    { ...status, snapshot: { ...completed, cancelRequested: undefined } },
    { ...status, snapshot: { ...completed, outcome: undefined } },
  ])("rejects missing or malformed frame data %j", (frame) => {
    expect(() => parseRelayMessage(frame)).toThrow();
  });

  it.each([result, error])("rejects mismatched nested $type response identities", (response) => {
    for (const field of ["requestId", "deviceId"] as const) {
      expect(() => parseRelayMessage({
        ...status,
        snapshot: { ...completed, payload: { status: "available", response: { ...response, [field]: queryId } } },
      })).toThrow();
    }
  });

  it.each([
    { state: "missing" },
    { state: "not_found", response: result },
    { state: "restarted", startedAt: now },
    { state: "running", startedAt: -1, cancelRequested: false },
    { state: "running", startedAt: 1.5, cancelRequested: false },
    { state: "running", startedAt: now },
    { state: "running", startedAt: now, cancelRequested: "false" },
    { ...completed, completedAt: -1 },
    { ...completed, completedAt: 1.5 },
    { ...completed, outcome: "cancelled" },
    { ...completed, unexpected: true },
    { ...completed, payload: { status: "missing" } },
    { ...completed, payload: { status: "expired", response: result } },
    { ...completed, payload: { status: "evicted", unexpected: true } },
    { ...completed, payload: { status: "unavailable", response: result } },
    { ...completed, payload: { status: "available", unexpected: true } },
    { ...completed, payload: { status: "available", response: { ...result, unexpected: true } } },
    { ...completed, payload: { status: "available", response: { ...error, error: { ...error.error, code: "NEW_ERROR" } } } },
  ])("rejects malformed or extra snapshot fields %j", (snapshot) => {
    expect(() => parseRelayMessage({ ...status, snapshot })).toThrow();
  });
});
