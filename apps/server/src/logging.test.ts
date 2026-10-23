import { describe, expect, it, vi } from "vitest";
import { createServerLogger, logMaintenanceFailure } from "./logging.js";

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

it("reports maintenance faults with only recognized codes and never propagates telemetry failures", () => {
  const records: unknown[] = [];
  const logger = createServerLogger({ sink: (record) => records.push(record), env: {} });
  const exception = Object.assign(new Error("private path /private/runtime"), { code: "SQLITE_BUSY" });
  logMaintenanceFailure(logger, "operation.cleanup_failed", exception);
  expect(records).toEqual([{ component: "server", event: "operation.cleanup_failed", code: "SQLITE_BUSY" }]);
  expect(JSON.stringify(records)).not.toContain("private path");

  const throwsOnCode = Object.defineProperty(new Error("do not log"), "code", {
    get: () => { throw new Error("getter unavailable"); },
  });
  expect(() => logMaintenanceFailure(logger, "relay.sweep_failed", throwsOnCode)).not.toThrow();
  expect(() => logMaintenanceFailure({ event: () => { throw Error("sink down"); } },
    "operation.cleanup_failed", exception)).not.toThrow();
});
