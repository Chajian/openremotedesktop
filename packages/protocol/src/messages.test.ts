import { describe, expect, it } from "vitest";
import {
  PROTOCOL_ERROR_CODES,
  ProtocolErrorEnvelopeSchema,
  parseRelayMessage,
} from "./index.js";

const deviceId = "6d1cf056-7fc5-49d4-8930-f989aafd957b";
const requestId = "8a4e7a20-8cad-4211-a277-8e0f4438d581";

describe("relay protocol schemas", () => {
  it.each([
    { type: "agent.hello", protocolVersion: 1, deviceId, agentVersion: "0.1.0", protocolRange: { min: 1, max: 1 }, platform: "linux", desktopCommanderVersion: "0.2.52", capabilities: ["desktop-commander"] },
    { type: "agent.ready", protocolVersion: 1, deviceId, desktopCommanderVersion: "0.2.52", capabilities: [], toolsHash: "catalog-hash" },
    { type: "agent.executor_status", protocolVersion: 1, deviceId, state: "READY" },
    { type: "heartbeat", protocolVersion: 1, deviceId, timestamp: 0 },
    { type: "tool.call", protocolVersion: 1, deviceId, requestId, toolName: "read_file", arguments: {} },
    { type: "tool.result", protocolVersion: 1, deviceId, requestId, result: { isError: true, content: [] } },
    { type: "tool.error", protocolVersion: 1, deviceId, requestId, error: { code: "EXECUTION_UNKNOWN", message: "Effect may have occurred" } },
    { type: "tool.cancel", protocolVersion: 1, deviceId, requestId },
    { type: "server.notice", protocolVersion: 1, level: "info", message: "Legacy notice" },
  ])("keeps the v1 $type wire fixture unchanged", (fixture) => {
    expect(parseRelayMessage(fixture)).toEqual(fixture);
    expect(() => parseRelayMessage({ ...fixture, bootId: requestId })).toThrow();
  });

  it("keeps every existing v1 error code unchanged", () => {
    expect(PROTOCOL_ERROR_CODES).toEqual([
      "DEVICE_NOT_FOUND", "DEVICE_OFFLINE", "DEVICE_NOT_READY", "DEVICE_REVOKED",
      "PROTOCOL_INCOMPATIBLE", "EXECUTOR_FAILED", "REQUEST_TIMEOUT", "REQUEST_CANCELLED",
      "EXECUTION_UNKNOWN", "TOOL_NOT_SUPPORTED", "TOOL_EXECUTION_ERROR",
    ]);
  });

  it("parses a valid agent.hello message", () => {
    const message = parseRelayMessage({
      type: "agent.hello",
      protocolVersion: 1,
      deviceId,
      agentVersion: "0.1.0",
      protocolRange: { min: 1, max: 1 },
      platform: "win32",
      desktopCommanderVersion: "0.2.52",
      capabilities: ["desktop-commander"],
    });

    expect(message.type).toBe("agent.hello");
    expect(message.deviceId).toBe(deviceId);
  });

  it("preserves a valid tool.call payload", () => {
    const args = { path: "C:/tmp/example.txt", offset: 0 };
    const message = parseRelayMessage({
      type: "tool.call",
      protocolVersion: 1,
      requestId,
      deviceId,
      toolName: "read_file",
      arguments: args,
    });

    expect(message).toMatchObject({ requestId, deviceId, toolName: "read_file" });
    if (message.type !== "tool.call") throw new Error("unexpected message type");
    expect(message.arguments).toEqual(args);
  });

  it("rejects unknown message types", () => {
    expect(() =>
      parseRelayMessage({ type: "agent.magic", protocolVersion: 1, deviceId }),
    ).toThrow();
  });

  it("rejects messages missing protocolVersion", () => {
    expect(() =>
      parseRelayMessage({ type: "heartbeat", deviceId, timestamp: Date.now() }),
    ).toThrow();
  });

  it("rejects malformed request and device identifiers", () => {
    expect(() =>
      parseRelayMessage({
        type: "tool.call",
        protocolVersion: 1,
        requestId: "not-a-uuid",
        deviceId,
        toolName: "read_file",
        arguments: {},
      }),
    ).toThrow();

    expect(() =>
      parseRelayMessage({
        type: "heartbeat",
        protocolVersion: 1,
        deviceId: "not-a-uuid",
        timestamp: Date.now(),
      }),
    ).toThrow();
  });

  it("allows separate valid messages to reuse a requestId at schema level", () => {
    const raw = {
      type: "tool.cancel",
      protocolVersion: 1,
      requestId,
      deviceId,
    } as const;

    expect(parseRelayMessage(raw)).toEqual(parseRelayMessage(raw));
  });

  it("serializes stable protocol error codes without parsing message text", () => {
    expect(PROTOCOL_ERROR_CODES).toContain("EXECUTION_UNKNOWN");
    const envelope = ProtocolErrorEnvelopeSchema.parse({
      code: "DEVICE_NOT_READY",
      message: "Device executor has not reached READY",
      details: { state: "EXECUTOR_STARTING" },
    });
    expect(envelope.code).toBe("DEVICE_NOT_READY");
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });
});
