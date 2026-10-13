import { afterEach, describe, expect, it } from "vitest";
import {
  connectMcpClient,
  startTestServer,
  waitFor,
} from "./helpers/test-server.js";
import { startFakeAgent } from "./helpers/test-agent.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function structured(result: unknown) {
  return (result as { structuredContent?: Record<string, unknown> })
    .structuredContent ?? {};
}

function listedDevices(result: unknown) {
  return (
    structured(result).devices as
      | Array<{ id: string; state: string; name: string }>
      | undefined
  ) ?? [];
}

describe("multi-device MCP routing", () => {
  it("routes explicitly, rejects ambiguity, and handles concurrent MCP clients", async () => {
    const server = await startTestServer();
    cleanups.push(() => server.close());
    const cookie = await server.bootstrapAndLogin();
    const token = await server.issueMcpAccessToken(cookie);
    const credentialA = await server.pairDevice(cookie, "Machine A");
    const credentialB = await server.pairDevice(cookie, "Machine B");
    const agentA = await startFakeAgent(credentialA, "A", {
      responseDelayMs: 50,
    });
    const agentB = await startFakeAgent(credentialB, "B");
    cleanups.push(() => agentA.stop());
    cleanups.push(() => agentB.stop());

    const clientA = await connectMcpClient(server.baseUrl, token);
    const clientB = await connectMcpClient(server.baseUrl, token);
    cleanups.push(() => clientA.close());
    cleanups.push(() => clientB.close());

    await waitFor(async () => {
      const list = await clientA.callTool({
        name: "list_devices",
        arguments: {},
      });
      const ready = listedDevices(list).filter(
        (device) => device.state === "READY",
      );
      return ready.length === 2;
    }, 10_000);

    const routedA = await clientA.callTool({
      name: "read_file",
      arguments: {
        deviceId: credentialA.deviceId,
        path: "C:/e2e-a.txt",
      },
    });
    const routedB = await clientA.callTool({
      name: "read_file",
      arguments: {
        deviceId: credentialB.deviceId,
        path: "C:/e2e-b.txt",
      },
    });
    expect(structured(routedA)).toMatchObject({ label: "A" });
    expect(structured(routedB)).toMatchObject({ label: "B" });

    const ambiguous = await clientA.callTool({
      name: "read_file",
      arguments: { path: "C:/ambiguous.txt" },
    });
    expect(ambiguous.isError).toBe(true);
    expect(structured(ambiguous)).toMatchObject({
      error: {
        code: "DEVICE_NOT_READY",
        details: { reason: "MULTIPLE_READY_DEVICES" },
      },
    });

    const [first, second] = await Promise.all([
      clientA.callTool({
        name: "read_file",
        arguments: {
          deviceId: credentialA.deviceId,
          path: "C:/concurrent-one.txt",
        },
      }),
      clientB.callTool({
        name: "read_file",
        arguments: {
          deviceId: credentialA.deviceId,
          path: "C:/concurrent-two.txt",
        },
      }),
    ]);
    expect(structured(first)).toMatchObject({ label: "A" });
    expect(structured(second)).toMatchObject({ label: "A" });
    expect(agentA.callCount).toBe(3);
  });

  it("returns EXECUTION_UNKNOWN after dispatched disconnect and never replays it", async () => {
    const server = await startTestServer();
    cleanups.push(() => server.close());
    const cookie = await server.bootstrapAndLogin();
    const token = await server.issueMcpAccessToken(cookie);
    const credential = await server.pairDevice(cookie, "Ambiguous Agent");
    const firstAgent = await startFakeAgent(credential, "first", {
      disconnectOnFirstCall: true,
    });
    cleanups.push(() => firstAgent.stop());

    const client = await connectMcpClient(server.baseUrl, token);
    cleanups.push(() => client.close());

    await waitFor(async () => {
      const list = await client.callTool({
        name: "list_devices",
        arguments: {},
      });
      return listedDevices(list).some(
        (device) =>
          device.id === credential.deviceId && device.state === "READY",
      );
    }, 10_000);

    const result = await client.callTool({
      name: "read_file",
      arguments: {
        deviceId: credential.deviceId,
        path: "C:/ambiguous-disconnect.txt",
      },
    });
    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({
      error: { code: "EXECUTION_UNKNOWN" },
    });
    expect(firstAgent.callCount).toBe(1);

    const secondAgent = await startFakeAgent(credential, "second");
    cleanups.push(() => secondAgent.stop());
    await waitFor(async () => {
      const list = await client.callTool({
        name: "list_devices",
        arguments: {},
      });
      return listedDevices(list).some(
        (device) =>
          device.id === credential.deviceId && device.state === "READY",
      );
    }, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondAgent.callCount).toBe(0);
  });
});
