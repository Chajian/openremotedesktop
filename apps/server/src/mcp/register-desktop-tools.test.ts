import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client, DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import type { OperationQueryResult } from "../operations/operation-service.js";
import type { Device } from "../devices/device-repository.js";
import { buildMcpServer } from "./mcp-handler.js";

const deviceId = "11111111-1111-4111-8111-111111111111";
const device: Device = {
  id: deviceId,
  name: "Game PC",
  ownerId: "owner-test",
  platform: "win32",
  agentVersion: "0.1.0",
  desktopCommanderVersion: "0.2.52",
  createdAt: 1,
  lastSeenAt: 2,
  revokedAt: null,
  deletedAt: null,
};

const foreignDeviceId = "22222222-2222-4222-8222-222222222222";
const foreignDevice: Device = { ...device, id: foreignDeviceId, name: "Foreign PC", ownerId: "foreign-test" };

async function fixture(
  nestedError = false,
  operation?: OperationQueryResult,
  toolTimeoutMs?: number,
  onRoute?: () => void,
) {
  const logs: Array<{ event: string; metadata: Record<string, unknown> }> = [];
  const calls: Array<{
    deviceId: string;
    toolName: string;
    args: unknown;
    timeoutMs: number;
  }> = [];

  const server = buildMcpServer({
    ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
    ...(operation ? {
      operationActor: () => ({ userId: "owner-test", clientId: "test-client", authorize: async () => true }),
      operations: {
        invoke: async () => { throw new Error("Query must not invoke an operation"); },
        query: async () => operation,
      },
    } : {}),
    devices: {
      listOwnedDevices: (ownerId: string) => {
        onRoute?.();
        return [device, foreignDevice].filter(d => d.ownerId === ownerId);
      },
    },
    authOwnerId: () => "owner-test",
    registry: {
      snapshot: () => [
        { deviceId, state: "READY" as const, connectedAt: 1, lastHeartbeatAt: 2 },
      ],
    },
    logger: {
      event: (event, metadata = {}) => logs.push({ event, metadata }),
    },
    broker: {
      call: async (target, toolName, args, options) => {
        calls.push({
          deviceId: target,
          toolName,
          args,
          timeoutMs: options.timeoutMs,
        });
        return {
          type: "tool.result" as const,
          protocolVersion: 1 as const,
          requestId: randomUUID(),
          deviceId: target,
          result: {
            ...(nestedError ? { isError: true } : {}),
            content: [{ type: "text" as const, text: "ok" }],
          },
        };
      },
    },
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    calls,
    logs,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("Desktop Commander MCP registration", () => {
  it("rejects a cached get_prompts call before dispatch after refreshing the public catalog", async () => {
    const f = await fixture();
    try {
      expect((await f.client.listTools()).tools.some(tool => tool.name === "get_prompts")).toBe(false);
      await expect(f.client.callTool({ name: "get_prompts", arguments: { deviceId } }))
        .rejects.toThrow(/Tool get_prompts not found/);
      expect(f.calls).toHaveLength(0);
    } finally { await f.close(); }
  });

  it.each([
    ["start_search", { path: "/fixture", pattern: "x", contextLines: -1 }],
    ["start_search", { path: "/fixture", pattern: "x", contextLines: 0.5 }],
    ["start_search", { path: "/fixture", pattern: "x", maxResults: -1 }],
    ["start_search", { path: "/fixture", pattern: "x", maxResults: 0.5 }],
    ["start_search", { path: "/fixture", pattern: "x", timeout_ms: -1 }],
    ["start_search", { path: "/fixture", pattern: "x", timeout_ms: 0.5 }],
    ["get_more_search_results", { sessionId: "fixture", offset: 0.5 }],
    ["get_more_search_results", { sessionId: "fixture", length: 0 }],
    ["get_more_search_results", { sessionId: "fixture", length: -1 }],
    ["get_more_search_results", { sessionId: "fixture", length: 0.5 }],
  ])("rejects invalid %s numeric arguments before routing: %j", async (name, argumentsValue) => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({ name, arguments: { deviceId, ...argumentsValue } });
      expect(result.isError).toBe(true);
      expect(f.calls).toHaveLength(0);
    } finally { await f.close(); }
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("forwards valid search limit %s unchanged to legacy agents", async limit => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({ name: "start_search", arguments: {
        deviceId, path: "/fixture", pattern: "x", maxResults: limit, contextLines: 0, timeout_ms: limit,
      } });
      expect(result.isError).not.toBe(true);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.args).toMatchObject({ maxResults: limit, contextLines: 0, timeout_ms: limit });
    } finally { await f.close(); }
  });

  it("exposes upstream annotations through the real MCP tools/list boundary", async () => {
    const f = await fixture();
    try {
      const { tools } = await f.client.listTools();
      expect(tools.find(tool => tool.name === "read_file")?.annotations)
        .toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tools.find(tool => tool.name === "write_file")?.annotations)
        .toMatchObject({ readOnlyHint: false, destructiveHint: true });
      for (const tool of tools) {
        expect(tool._meta ?? {}).not.toHaveProperty("ui/resourceUri");
        expect(tool._meta ?? {}).not.toHaveProperty("openai/outputTemplate");
        expect(tool._meta ?? {}).not.toHaveProperty("openai/widgetAccessible");
        expect(tool._meta?.ui ?? {}).not.toHaveProperty("resourceUri");
      }
    } finally { await f.close(); }
  });

  it("registers Desktop Commander tools as first-class tools with optional deviceId", async () => {
    const f = await fixture();
    try {
      const { tools } = await f.client.listTools();
      const readFile = tools.find((tool) => tool.name === "read_file");
      expect(readFile).toBeDefined();
      expect(readFile?.inputSchema.properties).toHaveProperty("deviceId");
      expect(readFile?.inputSchema.required ?? []).not.toContain("deviceId");
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["list_devices", "get_device_status", "odr_get_operation"]),
      );
    } finally {
      await f.close();
    }
  });

  it("strips deviceId before forwarding a Desktop Commander call", async () => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({
        name: "get_config",
        arguments: { deviceId },
      });
      expect(result.isError).not.toBe(true);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({
        deviceId,
        toolName: "get_config",
        args: {},
      });
    } finally {
      await f.close();
    }
  });

  it("logs tool-call metadata without arguments or result bodies", async () => {
    const f = await fixture();
    try {
      await f.client.callTool({
        name: "read_file",
        arguments: {
          deviceId,
          path: "C:/sensitive-project/private.txt",
        },
      });

      expect(f.logs).toHaveLength(1);
      expect(f.logs[0]?.event).toBe("tool.call");
      expect(f.logs[0]?.metadata).toMatchObject({
        deviceId,
        toolName: "read_file",
        success: true,
      });
      expect(f.logs[0]?.metadata).toHaveProperty("durationMs");
      const serialized = JSON.stringify(f.logs);
      expect(serialized).not.toContain("sensitive-project");
      expect(serialized).not.toContain('"arguments"');
      expect(serialized).not.toContain('"content"');
    } finally {
      await f.close();
    }
  });

  it("does not reveal or route devices owned by another account", async () => {
    const f = await fixture();
    try {
      const listed = await f.client.callTool({ name: "list_devices", arguments: {} });
      expect(JSON.stringify(listed.structuredContent)).not.toContain(foreignDeviceId);
      const result = await f.client.callTool({ name: "get_config", arguments: { deviceId: foreignDeviceId } });
      expect(result.isError).toBe(true);
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it("reports live devices through list_devices", async () => {
    const f = await fixture();
    try {
      const result = await f.client.callTool({
        name: "list_devices",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        devices: [
          {
            id: deviceId,
            name: "Game PC",
            state: "READY",
          },
        ],
      });
    } finally {
      await f.close();
    }
  });
});

it("logs a genuine nested tool error as unsuccessful while preserving its body", async () => {
 const f = await fixture(true);
 try { const result = await f.client.callTool({name:"get_config",arguments:{deviceId}});
 expect(result.isError).toBe(true); expect(f.logs[0]?.metadata.success).toBe(false);
 } finally { await f.close(); }
});


it("returns recovered payload only in structured content and useful metadata in text", async () => {
  const operationId = randomUUID();
  const marker = "retained-original-result-body";
  const operation: OperationQueryResult = {
    operationId, phase: "completed", outcome: "success",
    resultAvailability: "available", cancelRequested: false,
    snapshot: {
      state: "completed", completedAt: 1, outcome: "success", cancelRequested: false,
      payload: { status: "available", response: {
        type: "tool.result", protocolVersion: 1, deviceId, requestId: operationId,
        result: { content: [{ type: "text", text: marker }] },
      } },
    },
  };
  const f = await fixture(false, operation);
  try {
    const result = await f.client.callTool({ name: "odr_get_operation", arguments: { operationId } });
    expect(result.structuredContent).toEqual({ operation });
    expect(JSON.stringify(result.content)).not.toContain(marker);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({
      operationId, phase: "completed", outcome: "success",
      resultAvailability: "available", cancelRequested: false,
    }) }]);
  } finally {
    await f.close();
  }
});

it("reserves headroom before the MCP client's default timeout for every tool call", async () => {
  expect(DEFAULT_REQUEST_TIMEOUT_MSEC).toBeGreaterThan(10_000);
  for (const configured of [undefined, 120_000]) {
    const f = await fixture(false, undefined, configured);
    try {
      const result = await f.client.callTool({ name: "get_config", arguments: { deviceId } });
      expect(result.isError).not.toBe(true);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.timeoutMs).toBeGreaterThan(0);
      expect(f.calls[0]!.timeoutMs).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MSEC - 10_000);
    } finally { await f.close(); }
  }
});

it("includes routing latency in the MCP waiter budget and never dispatches past its deadline", async () => {
  let now = 10_000;
  const shortened = await fixture(false, undefined, undefined, () => { now += 7_000; });
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const result = await shortened.client.callTool({ name: "get_config", arguments: { deviceId } });
    expect(result.isError).not.toBe(true);
    expect(shortened.calls).toHaveLength(1);
    expect(shortened.calls[0]!.timeoutMs).toBe(38_000);
  } finally { clock.mockRestore(); await shortened.close(); }

  now = 10_000;
  const exhausted = await fixture(false, undefined, undefined, () => { now += 46_000; });
  const clock2 = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const result = await exhausted.client.callTool({ name: "get_config", arguments: { deviceId } });
    const error = (result.structuredContent as {
      error?: { code: string; details?: Record<string, unknown> };
    } | undefined)?.error;
    expect(error).toMatchObject({
      code: "REQUEST_TIMEOUT", details: { dispatched: false, reason: "deadline" },
    });
    expect(error?.details).not.toHaveProperty("operationId");
    expect(exhausted.calls).toHaveLength(0);
  } finally { clock2.mockRestore(); await exhausted.close(); }
});

it("never extends the 45-second MCP waiter when the system clock moves backwards", async () => {
  let wall = 30_000;
  let monotonic = 10_000;
  const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wall);
  const monotonicClock = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  try {
    const first = await fixture(false, undefined, undefined, () => {
      wall -= 90_000;
      monotonic += 12_000;
    });
    try {
      const result = await first.client.callTool({ name: "get_config", arguments: { deviceId } });
      expect(result.isError).not.toBe(true);
      expect(first.calls).toHaveLength(1);
      expect(first.calls[0]!.timeoutMs).toBe(33_000);
      expect(first.calls[0]!.timeoutMs).toBeLessThanOrEqual(45_000);
    } finally { await first.close(); }

    wall = 30_000;
    monotonic = 10_000;
    const second = await fixture(false, undefined, undefined, () => {
      wall -= 120_000;
      monotonic += 46_000;
    });
    try {
      const result = await second.client.callTool({ name: "get_config", arguments: { deviceId } });
      expect(result.structuredContent).toMatchObject({
        error: { code: "REQUEST_TIMEOUT", details: { reason: "deadline", dispatched: false } },
      });
      expect(second.calls).toHaveLength(0);
    } finally { await second.close(); }
  } finally {
    wallClock.mockRestore();
    monotonicClock.mockRestore();
  }
});
