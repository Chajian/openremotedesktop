import { describe, expect, it, vi } from "vitest";
import {
  ExecutorManager,
  type ExecutorClient,
} from "./executor-manager.js";

function fakeClient(): ExecutorClient & { closeCalls: number } {
  return {
    closeCalls: 0,
    async listTools() {
      return [{ name: "read_file" }];
    },
    async callTool() {
      return { content: [] };
    },
    async close() {
      this.closeCalls += 1;
    },
  };
}

describe("ExecutorManager", () => {
  it("emits EXECUTOR_STARTING then READY only after local MCP initializes", async () => {
    const states: string[] = [];
    const client = fakeClient();
    const manager = new ExecutorManager({
      startClient: vi.fn().mockResolvedValue(client),
      onState: (state) => states.push(state),
    });

    expect(manager.state()).toBe("AUTHENTICATED");
    await manager.start();

    expect(states).toEqual(["EXECUTOR_STARTING", "READY"]);
    expect(manager.state()).toBe("READY");
  });

  it("moves to EXECUTOR_FAILED when startup or the running client fails", async () => {
    const manager = new ExecutorManager({
      startClient: vi.fn().mockRejectedValue(new Error("spawn failed")),
    });

    await expect(manager.start()).rejects.toThrow("spawn failed");
    expect(manager.state()).toBe("EXECUTOR_FAILED");

    const recovered = fakeClient();
    manager.setClientFactory(vi.fn().mockResolvedValue(recovered));
    await manager.restart();
    expect(manager.state()).toBe("READY");

    manager.markCrashed();
    expect(manager.state()).toBe("EXECUTOR_FAILED");
  });

  it("reuses a READY client rather than restarting it", async () => {
    const client = fakeClient();
    const startClient = vi.fn().mockResolvedValue(client);
    const manager = new ExecutorManager({ startClient });

    await manager.start();
    await manager.start();

    expect(startClient).toHaveBeenCalledTimes(1);
    expect(client.closeCalls).toBe(0);
  });
});
