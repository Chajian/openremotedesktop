import { describe, expect, it } from "vitest";
import { DesktopCommanderClient, assertDesktopCommanderCatalog } from "@open-desktop-remote/desktop-commander-adapter";
import { ExecutorManager } from "./executor-manager.js";

// Observe the real child, without making process handles part of the public API.
function childPid(client: DesktopCommanderClient): number {
  const transport = Reflect.get(client, "transport") as { readonly pid: number | null };
  const pid = transport.pid;
  if (pid === null) throw new Error("Expected a running stdio child");
  return pid;
}

describe("ExecutorManager with the original Desktop Commander subprocess", () => {
  it("reaps a real child after a post-handshake tool-list failure", async () => {
    let pid: number | undefined;
    let created: DesktopCommanderClient | undefined;
    const failure = new Error("Injected registry failure after real MCP initialization");
    const manager = new ExecutorManager({ validateTools: assertDesktopCommanderCatalog, startClient: async (onCreated) => {
      const client = await DesktopCommanderClient.start({ onCreated });
      created = client;
      pid = childPid(client);
      // Only the failing registry response is injected; ownership and cleanup
      // run through the real adapter, SDK and OS child process.
      client.listTools = async () => { throw failure; };
      return client;
    } });
    try {
      await expect(manager.start()).rejects.toBe(failure);
      expect(manager.state()).toBe("EXECUTOR_FAILED");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      try { await manager.close(); } finally { await created?.close(); }
    }
  }, 45_000);

  it("reaps a real READY child after protocol incompatibility", async () => {
    let pid: number | undefined;
    let created: DesktopCommanderClient | undefined;
    const manager = new ExecutorManager({ validateTools: assertDesktopCommanderCatalog, startClient: async (onCreated) => {
      const client = await DesktopCommanderClient.start({ onCreated });
      created = client;
      pid = childPid(client);
      return client;
    } });
    try {
      await manager.start();
      manager.markIncompatible();
      await expect(manager.callTool("get_config", {})).rejects.toThrow(/not READY/);
      await Promise.all([manager.close(), manager.close()]);
      expect(manager.state()).toBe("OFFLINE");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      try { await manager.close(); } finally { await created?.close(); }
    }
  }, 45_000);
});
