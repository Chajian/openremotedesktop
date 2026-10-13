import { describe, expect, it, vi } from "vitest";
import { createServerLogger } from "./logging.js";

describe("createServerLogger", () => {
  it("emits redacted metadata and suppresses payloads by default", () => {
    const records: unknown[] = [];
    const logger = createServerLogger({
      env: {},
      sink: (record) => records.push(record),
      warn: vi.fn(),
    });

    logger.event("tool.call", {
      requestId: "req-1",
      deviceId: "dev-1",
      toolName: "read_file",
      durationMs: 15,
      errorCode: "DEVICE_OFFLINE",
      authorization: "Bearer hidden",
      arguments: { path: "secret.txt" },
    });
    logger.payload("relay.message", { deviceId: "dev-1" }, {
      content: "secret file body",
    });

    expect(records).toEqual([
      {
        component: "server",
        event: "tool.call",
        requestId: "req-1",
        deviceId: "dev-1",
        toolName: "read_file",
        durationMs: 15,
        errorCode: "DEVICE_OFFLINE",
        authorization: "[REDACTED]",
        arguments: "[REDACTED]",
      },
    ]);
  });

  it("only emits debug payloads after explicit opt-in and warns once", () => {
    const records: unknown[] = [];
    const warn = vi.fn();
    const logger = createServerLogger({
      env: { DEBUG_PAYLOAD_LOGGING: "true" },
      sink: (record) => records.push(record),
      warn,
    });

    logger.payload("relay.message", { deviceId: "dev-1" }, {
      marker: "DEBUG_PAYLOAD_MARKER",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/sensitive/i);
    expect(JSON.stringify(records)).toContain("DEBUG_PAYLOAD_MARKER");
  });
});
