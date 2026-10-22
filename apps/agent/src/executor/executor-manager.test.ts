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

it("notifies invalidation on replacement and ignores close callbacks from an old client", async () => {
  const clients = [fakeClient(), fakeClient()];
  const closes: Array<() => void> = [];
  for (const client of clients) client.onClose = (handler) => { closes.push(handler); };
  let index = 0;
  const manager = new ExecutorManager({ startClient: async () => clients[index++]! });
  await manager.start();
  let invalidations = 0;
  const stop = manager.onInvalidated(() => { invalidations++; });
  await manager.restart(); expect(invalidations).toBe(1);
  closes[0]!(); expect(manager.state()).toBe("READY"); expect(invalidations).toBe(1);
  closes[1]!(); expect(manager.state()).toBe("EXECUTOR_FAILED"); expect(invalidations).toBe(2);
  stop(); manager.markIncompatible(); expect(invalidations).toBe(2);
});

it("coalesces concurrent executor startup to one client", async () => {
  let release!: () => void;
  let starts = 0;
  const manager = new ExecutorManager({ startClient: async () => {
    starts++; await new Promise<void>((resolve) => { release = resolve; }); return fakeClient();
  } });
  const one = manager.start(); const two = manager.start();
  expect(starts).toBe(1); release(); await Promise.all([one, two]);
  expect(manager.state()).toBe("READY");
});

it("does not let a late startup overwrite an invalidated executor epoch", async () => {
  let release!: () => void;
  const client = fakeClient();
  const manager = new ExecutorManager({ startClient: async () => {
    await new Promise<void>((resolve) => { release = resolve; }); return client;
  } });
  const pending = manager.start(); manager.markIncompatible(); release(); await pending;
  expect(manager.state()).toBe("INCOMPATIBLE"); expect(client.closeCalls).toBe(1);
});
