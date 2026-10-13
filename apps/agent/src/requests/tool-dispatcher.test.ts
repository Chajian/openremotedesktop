import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ToolCallMessage } from "@open-desktop-remote/protocol";
import { ToolDispatcher } from "./tool-dispatcher.js";

const deviceId = "6d1cf056-7fc5-49d4-8930-f989aafd957b";

function call(requestId = randomUUID(), args: Record<string, unknown> = {}): ToolCallMessage {
  return {
    type: "tool.call",
    protocolVersion: 1,
    requestId,
    deviceId,
    toolName: "read_file",
    arguments: args,
  };
}

function executor(result: unknown = { content: [{ type: "text", text: "ok" }] }) {
  return {
    callTool: vi.fn(async () => result),
  };
}

describe("ToolDispatcher", () => {
  it("deduplicates a completed requestId and returns its cached result", async () => {
    const local = executor();
    const dispatcher = new ToolDispatcher(local);
    const message = call();

    const first = await dispatcher.handle(message);
    const second = await dispatcher.handle(message);

    expect(local.callTool).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.type).toBe("tool.result");
  });

  it("executes distinct request ids independently", async () => {
    const local = executor();
    const dispatcher = new ToolDispatcher(local);

    await dispatcher.handle(call());
    await dispatcher.handle(call());

    expect(local.callTool).toHaveBeenCalledTimes(2);
  });

  it("returns REQUEST_CANCELLED when an in-flight request is cancelled", async () => {
    let resolve!: (value: unknown) => void;
    const local = {
      callTool: vi.fn(
        () =>
          new Promise<unknown>((done) => {
            resolve = done;
          }),
      ),
    };
    const dispatcher = new ToolDispatcher(local);
    const message = call();

    const pending = dispatcher.handle(message);
    await vi.waitFor(() => expect(local.callTool).toHaveBeenCalledTimes(1));
    dispatcher.cancel(message.requestId);
    resolve({ content: [{ type: "text", text: "late" }] });

    const result = await pending;
    expect(result.type).toBe("tool.error");
    if (result.type !== "tool.error") throw new Error("expected tool.error");
    expect(result.error.code).toBe("REQUEST_CANCELLED");
  });

  it("rejects a serialized result larger than the configured limit", async () => {
    const local = executor({ content: [{ type: "text", text: "x".repeat(256) }] });
    const dispatcher = new ToolDispatcher(local, { maxResultBytes: 128 });

    const result = await dispatcher.handle(call());

    expect(result.type).toBe("tool.error");
    if (result.type !== "tool.error") throw new Error("expected tool.error");
    expect(result.error.code).toBe("TOOL_EXECUTION_ERROR");
    expect(result.error.details).toMatchObject({
      reason: "RESULT_TOO_LARGE",
      maxBytes: 128,
    });
  });

  it("coalesces concurrent duplicates onto one local execution", async () => {
    let resolve!: (value: unknown) => void;
    const local = {
      callTool: vi.fn(
        () =>
          new Promise<unknown>((done) => {
            resolve = done;
          }),
      ),
    };
    const dispatcher = new ToolDispatcher(local);
    const message = call();

    const one = dispatcher.handle(message);
    const two = dispatcher.handle(message);
    await vi.waitFor(() => expect(local.callTool).toHaveBeenCalledTimes(1));
    resolve({ content: [{ type: "text", text: "done" }] });

    expect(await two).toEqual(await one);
    expect(local.callTool).toHaveBeenCalledTimes(1);
  });
});
