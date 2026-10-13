import { describe, expect, it } from "vitest";
import {
  PROTOCOL_ERROR_CODES,
  ProtocolErrorEnvelopeSchema,
  parseRelayMessage,
} from "./index.js";

const deviceId = "6d1cf056-7fc5-49d4-8930-f989aafd957b";
const requestId = "8a4e7a20-8cad-4211-a277-8e0f4438d581";

describe("relay protocol schemas", () => {
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
