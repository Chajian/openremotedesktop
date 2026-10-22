import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
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
};

const foreignDeviceId = "22222222-2222-4222-8222-222222222222";
const foreignDevice: Device = { ...device, id: foreignDeviceId, name: "Foreign PC", ownerId: "foreign-test" };

async function fixture(nestedError = false) {
  const logs: Array<{ event: string; metadata: Record<string, unknown> }> = [];
  const calls: Array<{
    deviceId: string;
    toolName: string;
    args: unknown;
    timeoutMs: number;
  }> = [];

  const server = buildMcpServer({
    devices: {
      listOwnedDevices: (ownerId: string) => [device, foreignDevice].filter(d => d.ownerId === ownerId),
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
