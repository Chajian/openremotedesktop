import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, vi } from "vitest";
import { DesktopCommanderClient } from "../../packages/desktop-commander-adapter/src/desktop-commander-client.js";
import { ExecutorManager, type ExecutorClient } from "../../apps/agent/src/executor/executor-manager.js";
import { OperationCoordinator, OperationStore } from "../../apps/agent/src/requests/operation-store.js";

const deviceId = randomUUID();
const bootId = randomUUID();

async function connectedLocalSdk(hang: boolean) {
  let executions = 0;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.onmessage = async (message) => {
    const inbound = message as { id?: number | string; method?: string; params?: {
      protocolVersion?: string;
    } };
    if (inbound.id === undefined) return;
    const respond = async (result: unknown) => serverTransport.send({
      jsonrpc: "2.0", id: inbound.id, result,
    } as never);
    if (inbound.method === "initialize") {
      await respond({ protocolVersion: inbound.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} }, serverInfo: { name: "hanging-local-sdk", version: "1.0.0" } });
    } else if (inbound.method === "tools/list") {
      await respond({ tools: [{ name: "write_file", inputSchema: {
        type: "object", properties: { a: { type: "number" } },
      } }] });
    } else if (inbound.method === "tools/call") {
      executions++;
      if (!hang) await respond({ isError: true,
        content: [{ type: "text", text: "Tool business error" }] });
      // The connection remains OPEN but no response is sent for the hung request.
    }
  };
  await serverTransport.start();
  const sdkClient = new Client({ name: "local-executor-probe", version: "1.0.0" });
  await sdkClient.connect(clientTransport);
  // The adapter's constructor is private for runtime callers. Construct it only
  // in this integration probe, using a real connected MCP SDK Client.
  const adapter = Reflect.construct(DesktopCommanderClient, [sdkClient, clientTransport]) as DesktopCommanderClient;
  return {
    adapter, sdkClient, closeServer: () => serverTransport.close(),
    executions: () => executions,
  };
}

function request() {
  return {
    type: "operation.call" as const, protocolVersion: 1 as const,
    deviceId, bootId, requestId: randomUUID(), toolName: "write_file",
    arguments: { a: 1 }, expiresAt: 61_000,
  };
}

describe("Agent -> real MCP SDK timeout and executor watchdog", () => {
  it("keeps the SDK request alive past 60s and recovers a hung executor once at its watchdog deadline", async () => {
    const sdk = await connectedLocalSdk(true);
    let starts = 0;
    let recoveries = 0;
    let replayed = 0;
    const manager = new ExecutorManager({ startClient: async (): Promise<ExecutorClient> => {
      if (++starts === 1) return sdk.adapter;
      return {
        listTools: async () => [{ name: "write_file" }],
        callTool: async () => { replayed++; return { content: [] }; },
        close: async () => undefined,
      };
    } });
    await manager.start();
    const sdkCall = vi.spyOn(sdk.sdkClient, "callTool");
    const store = new OperationStore({ deviceId, bootId, now: () => 1_000 });
    const coordinator = new OperationCoordinator(manager, store, {
      maxExecutionMs: 600_000,
      recoverExecutor: async () => { recoveries++; await manager.restart(); },
    });
    const off = manager.onInvalidated(() => coordinator.invalidateRunning());
    vi.useFakeTimers();
    try {
      const call = request();
      const pending = coordinator.handle(call);
      await vi.advanceTimersByTimeAsync(1);
      expect(sdk.executions()).toBe(1);
      expect(sdkCall).toHaveBeenCalledTimes(1);
      expect(sdkCall).toHaveBeenCalledWith(expect.objectContaining({
        name: "write_file",
      }), expect.objectContaining({
        timeout: 630_000, maxTotalTimeout: 630_000,
      }));
      // The SDK must not abort at its default 60 seconds and clear our watchdog.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.read(call.requestId, bootId, false)).toMatchObject({ state: "running" });
      expect(manager.state()).toBe("READY");
      expect(recoveries).toBe(0);

      await vi.advanceTimersByTimeAsync(540_000);
      const result = await pending;
      expect(result).toMatchObject({
        type: "tool.error", error: { code: "EXECUTION_UNKNOWN",
          details: { reason: "EXECUTOR_REPLACED" } },
      });
      expect(store.read(call.requestId, bootId, false)).toMatchObject({
        state: "completed", outcome: "unknown",
      });
      expect(recoveries).toBe(1);
      expect(manager.state()).toBe("READY");
      expect(starts).toBe(2);
      expect(sdk.executions()).toBe(1);
      expect(replayed).toBe(0);

      await expect(coordinator.handle(call)).resolves.toEqual(result);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(recoveries).toBe(1);
      expect(replayed).toBe(0);
    } finally {
      vi.useRealTimers();
      off();
      await manager.close();
      await sdk.closeServer();
    }
  });

  it("does not recycle the executor for an ordinary isError tool response", async () => {
    const sdk = await connectedLocalSdk(false);
    let recoveries = 0;
    const manager = new ExecutorManager({ startClient: async () => sdk.adapter });
    await manager.start();
    const sdkCall = vi.spyOn(sdk.sdkClient, "callTool");
    const coordinator = new OperationCoordinator(manager,
      new OperationStore({ deviceId, bootId, now: () => 1_000 }), {
        maxExecutionMs: 30,
        recoverExecutor: async () => { recoveries++; await manager.restart(); },
      });
    const off = manager.onInvalidated(() => coordinator.invalidateRunning());
    try {
      const call = request();
      const response = await coordinator.handle(call);
      expect(response).toMatchObject({ type: "tool.result", result: { isError: true } });
      expect(sdk.executions()).toBe(1);
      expect(sdkCall).toHaveBeenCalledWith(expect.anything(),
        expect.objectContaining({ timeout: 30_030, maxTotalTimeout: 30_030 }));
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(recoveries).toBe(0);
      expect(manager.state()).toBe("READY");
    } finally {
      off();
      await manager.close();
      await sdk.closeServer();
    }
  });
});

it("recycles a genuinely hung stdio child once without replaying its command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odr-sdk-stalled-"));
  const callLog = join(dir, "calls.log");
  const script = fileURLToPath(new URL("./helpers/hung-local-stdio-server.mjs", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script],
    env: { ...getDefaultEnvironment(), ODR_TEST_CALL_LOG: callLog },
    stderr: "pipe",
  });
  const sdkClient = new Client({ name: "stdio-watchdog", version: "1.0.0" });
  let manager: ExecutorManager | undefined;
  let off: (() => void) | undefined;
  try {
    await sdkClient.connect(transport);
    const adapter = Reflect.construct(DesktopCommanderClient, [sdkClient, transport]) as DesktopCommanderClient;
    let starts = 0;
    let recoveries = 0;
    let replacementEffects = 0;
    manager = new ExecutorManager({ startClient: async () => {
      if (++starts === 1) return adapter;
      return {
        listTools: async () => [{ name: "write_file" }],
        callTool: async () => { replacementEffects++; return { content: [] }; },
        close: async () => undefined,
      };
    } });
    await manager.start();
    const store = new OperationStore({ deviceId, bootId, now: () => 1_000 });
    const coordinator = new OperationCoordinator(manager, store, {
      maxExecutionMs: 250,
      recoverExecutor: async () => { recoveries++; await manager!.restart(); },
    });
    off = manager.onInvalidated(() => coordinator.invalidateRunning());
    const call = request();
    const pending = coordinator.handle(call);
    await vi.waitFor(() => expect(existsSync(callLog)).toBe(true), { timeout: 5_000 });
    const result = await pending;
    expect(result).toMatchObject({ type: "tool.error", error: { code: "EXECUTION_UNKNOWN" } });
    await vi.waitFor(() => expect(manager!.state()).toBe("READY"), { timeout: 10_000 });
    expect(recoveries).toBe(1);
    expect(starts).toBe(2);
    expect(readFileSync(callLog, "utf8")).toBe("called\n");
    expect(replacementEffects).toBe(0);
    expect(store.read(call.requestId, bootId, true)).toMatchObject({
      state: "completed", outcome: "unknown",
    });
    await expect(coordinator.handle(call)).resolves.toEqual(result);
    expect(readFileSync(callLog, "utf8")).toBe("called\n");
    expect(replacementEffects).toBe(0);
  } finally {
    off?.();
    if (manager) await manager.close();
    await sdkClient.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
