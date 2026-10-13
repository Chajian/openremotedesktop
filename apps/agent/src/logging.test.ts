import { describe, expect, it, vi } from "vitest";
import { createAgentLogger } from "./logging.js";

describe("createAgentLogger", () => {
  it("uses metadata-only logging by default", () => {
    const records: unknown[] = [];
    const logger = createAgentLogger({
      env: {},
      sink: (record) => records.push(record),
      warn: vi.fn(),
    });

    logger.event("executor.state", {
      deviceId: "dev-1",
      state: "READY",
      refreshCredential: "hidden",
    });
    logger.payload("tool.result", { requestId: "req-1" }, {
      stdout: "secret output",
    });

    expect(records).toEqual([
      {
        component: "agent",
        event: "executor.state",
        deviceId: "dev-1",
        state: "READY",
        refreshCredential: "[REDACTED]",
      },
    ]);
  });
});
