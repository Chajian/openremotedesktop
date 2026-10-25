import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutorClient } from "../../apps/agent/src/executor/executor-manager.js";
import { DesktopCommanderClient } from "../../packages/desktop-commander-adapter/src/desktop-commander-client.js";
import { OPERATION_RECOVERY_NOTICE, type OperationSnapshot } from "../../packages/protocol/src/index.js";
import { barrier, startRecoveryAgent } from "./helpers/recovery-agent.js";
import { startFakeAgent } from "./helpers/test-agent.js";
import { connectMcpClient, startTestServer, waitFor } from "./helpers/test-server.js";

type OperationView = {
  operationId: string;
  phase: string;
  resultAvailability: string;
  snapshot?: OperationSnapshot;
};
type QueryReply = {
  structuredContent?: { operation?: OperationView | { state: "not_found" } };
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("operation recovery over real MCP and WebSocket transports", () => {
  for (const originalUpstream of [false, true]) {
    it(`recovers one completed effect after reconnect (${originalUpstream ? "original Desktop Commander stdio" : "controlled executor"})`, async () => {
      const server = await startTestServer();
      cleanups.push(() => server.close());
      const cookie = await server.bootstrapAndLogin();
      const token = await server.issueMcpAccessToken(cookie);
      const credential = await server.pairDevice(cookie, "Recovery Test Agent");
      const directory = mkdtempSync(join(tmpdir(), "odr-recovery-"));
      cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
      const marker = join(directory, "effect.txt");
      const effect = barrier();
      const releaseResult = barrier();
      const returned = barrier();
      let executions = 0;
      let originalResult: unknown;
      const startClient = async (): Promise<ExecutorClient> => {
        const client: ExecutorClient = originalUpstream
          ? await DesktopCommanderClient.start({ cwd: directory })
          : {
              listTools: async () => [{ name: "write_file" }],
              callTool: async () => {
                appendFileSync(marker, "one effect\n");
                return { content: [{ type: "text", text: "saved original result" }] };
              },
              close: async () => undefined,
            };
        return {
          listTools: () => client.listTools(),
          callTool: async (name, args) => {
            executions += 1;
            const result = await client.callTool(name, args);
            originalResult = JSON.parse(JSON.stringify(result));
            effect.release();
            await releaseResult.promise;
            returned.release();
            return result;
          },
          close: () => client.close(),
          ...(client instanceof DesktopCommanderClient
            ? { onClose: (listener: () => void) => client.onClose(listener) }
            : {}),
        };
      };
      const agent = startRecoveryAgent(credential, startClient);
      cleanups.push(async () => { releaseResult.release(); await agent.stop(); });
      const client = await connectMcpClient(server.baseUrl, token);
      cleanups.push(() => client.close());
      await waitFor(async () => {
        const devices = await client.callTool({ name: "list_devices", arguments: {} });
        const entries = devices.structuredContent?.devices as Array<{ id: string; state: string }>;
        return entries.some((device) => device.id === credential.deviceId && device.state === "READY");
      }, 20_000);
      await waitFor(() => Boolean(server.relayRegistry.get(credential.deviceId)?.bootId));

      const invocation = client.callTool({
        name: "write_file",
        arguments: { deviceId: credential.deviceId, path: marker, content: "one effect\n", mode: "append" },
      });
      await effect.promise;
      expect(readFileSync(marker, "utf8")).toBe("one effect\n");
      agent.dropConnection();
      const ambiguous = await invocation;
      const error = ambiguous.structuredContent?.error as {
        code: string; details?: { operationId?: string; recovery?: boolean };
      };
      expect(error.code).toBe("EXECUTION_UNKNOWN");
      expect(error.details?.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(error.details?.recovery).toBe(true);
      const operationId = error.details!.operationId!;

      // Complete while disconnected, so only the Agent's saved outcome can recover it.
      releaseResult.release();
      await returned.promise;
      await setImmediate();
      agent.allowReconnect();
      await waitFor(() => agent.connections >= 2);
      await waitFor(() => agent.received.filter((message) =>
        message.type === "server.notice" && message.code === OPERATION_RECOVERY_NOTICE).length >= 2);
      await waitFor(() => Boolean(server.relayRegistry.get(credential.deviceId)?.bootId));

      const query = async (includeResult = true) => await client.callTool({
        name: "odr_get_operation", arguments: { operationId, includeResult },
      }) as QueryReply;
      let recovered: OperationView | undefined;
      await waitFor(async () => {
        const operation = (await query()).structuredContent?.operation;
        if (!operation || "state" in operation) return false;
        recovered = operation;
        return operation.resultAvailability === "available";
      });
      expect(recovered).toMatchObject({ operationId, phase: "completed", resultAvailability: "available" });
      expect(recovered?.snapshot).toMatchObject({ state: "completed", outcome: "success", cancelRequested: false });
      const snapshot = recovered!.snapshot!;
      if (snapshot.state !== "completed" || snapshot.payload.status !== "available") throw new Error("missing saved result");
      expect(snapshot.payload.response).toMatchObject({ type: "tool.result", requestId: operationId });
      if (snapshot.payload.response?.type !== "tool.result") throw new Error("missing original response");
      expect(snapshot.payload.response.result).toEqual(originalResult);
      if (!originalUpstream) {
        expect(snapshot.payload.response.result).toEqual({ content: [{ type: "text", text: "saved original result" }] });
      }
      expect((await query()).structuredContent?.operation).toEqual(recovered);
      const metadata = (await query(false)).structuredContent?.operation as OperationView;
      expect(metadata.snapshot).toMatchObject({ state: "completed", payload: { status: "available" } });
      expect(metadata.snapshot?.state === "completed" && metadata.snapshot.payload).not.toHaveProperty("response");

      const anotherToken = await server.issueMcpAccessToken(cookie);
      const anotherClient = await connectMcpClient(server.baseUrl, anotherToken);
      cleanups.push(() => anotherClient.close());
      for (const id of [operationId, randomUUID()]) {
        const hidden = await anotherClient.callTool({ name: "odr_get_operation", arguments: { operationId: id } }) as QueryReply;
        expect(hidden.structuredContent?.operation).toEqual({ state: "not_found" });
      }
      expect(executions).toBe(1);
      expect(agent.received.filter((message) => message.type === "operation.call" || message.type === "tool.call")).toHaveLength(1);
      expect(readFileSync(marker, "utf8")).toBe("one effect\n");
      expect(agent.failure).toBeUndefined();
    });
  }

  it("keeps the real Server non-ready until a stalled executor has closed", async () => {
    const server = await startTestServer();
    cleanups.push(() => server.close());
    const cookie = await server.bootstrapAndLogin();
    const token = await server.issueMcpAccessToken(cookie);
    const credential = await server.pairDevice(cookie, "Stalled Executor Test");
    const closeOld = barrier();
    let starts = 0;
    let executions = 0;
    const agent = startRecoveryAgent(credential, async () => {
      const generation = ++starts;
      return {
        listTools: async () => [{ name: "read_file" }],
        callTool: async () => {
          executions++;
          if (generation === 1) return new Promise(() => undefined);
          return { content: [{ type: "text", text: "recovered" }] };
        },
        close: async () => { if (generation === 1) await closeOld.promise; },
      };
    }, { stalledOperationTimeoutMs: 40 });
    cleanups.push(async () => { closeOld.release(); await agent.stop(); });
    const client = await connectMcpClient(server.baseUrl, token);
    cleanups.push(() => client.close());
    await waitFor(() => server.relayRegistry.get(credential.deviceId)?.state === "READY");
    await waitFor(() => Boolean(server.relayRegistry.get(credential.deviceId)?.bootId));

    const first = client.callTool({ name: "read_file", arguments: {
      deviceId: credential.deviceId, path: "/not-used",
    } });
    await waitFor(() => server.relayRegistry.get(credential.deviceId)?.state === "EXECUTOR_FAILED");
    expect(starts).toBe(1);
    expect(executions).toBe(1);
    const unknown = await first;
    expect(unknown.structuredContent?.error).toMatchObject({ code: "EXECUTION_UNKNOWN" });
    const refused = await client.callTool({ name: "read_file", arguments: {
      deviceId: credential.deviceId, path: "/not-used",
    } });
    expect(refused.structuredContent?.error).toMatchObject({ code: "DEVICE_NOT_READY" });
    expect(executions).toBe(1);

    closeOld.release();
    await waitFor(() => server.relayRegistry.get(credential.deviceId)?.state === "READY");
    expect(starts).toBe(2);
    const recovered = await client.callTool({ name: "read_file", arguments: {
      deviceId: credential.deviceId, path: "/not-used",
    } });
    expect(recovered.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(executions).toBe(2);
    expect(agent.failure).toBeUndefined();
  });

  it("keeps the Relay connected when a stalled executor shutdown fails", async () => {
    const server = await startTestServer();
    cleanups.push(() => server.close());
    const cookie = await server.bootstrapAndLogin();
    const token = await server.issueMcpAccessToken(cookie);
    const credential = await server.pairDevice(cookie, "Shutdown Failure Test");
    let starts = 0;
    let executed = 0;
    let closeCalls = 0;
    let failClose = true;
    const agent = startRecoveryAgent(credential, async () => {
      starts++;
      return {
        listTools: async () => [{ name: "read_file" }],
        callTool: async () => { executed++; return new Promise(() => undefined); },
        close: async () => {
          closeCalls++;
          if (failClose) throw new Error("simulated close failure");
        },
      };
    }, { stalledOperationTimeoutMs: 40 });
    cleanups.push(async () => { failClose = false; await agent.stop(); });
    const client = await connectMcpClient(server.baseUrl, token);
    cleanups.push(() => client.close());
    await waitFor(() => server.relayRegistry.get(credential.deviceId)?.state === "READY");
    await waitFor(() => Boolean(server.relayRegistry.get(credential.deviceId)?.bootId));
    const original = client.callTool({ name: "read_file",
      arguments: { deviceId: credential.deviceId, path: "/not-used" } });
    await waitFor(() => server.relayRegistry.get(credential.deviceId)?.state === "EXECUTOR_FAILED");
    expect((await original).structuredContent?.error).toMatchObject({ code: "EXECUTION_UNKNOWN" });
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(server.relayRegistry.get(credential.deviceId)?.state).toBe("EXECUTOR_FAILED");
    expect(starts).toBe(1);
    expect(executed).toBe(1);
    expect(agent.connections).toBe(1);
    expect(closeCalls).toBe(1);
    await expect(agent.stop()).rejects.toThrow("shutdown could not be confirmed");
    expect(closeCalls).toBe(2);
    // Remove the injected fault explicitly; final cleanup must retry the
    // original handle rather than silently forgetting the failed shutdown.
    failClose = false;
    await agent.stop();
    expect(closeCalls).toBe(3);
  });

  it("keeps an old Agent on legacy calls and reports the recovery limitation", async () => {
    const server = await startTestServer();
    cleanups.push(() => server.close());
    const cookie = await server.bootstrapAndLogin();
    const token = await server.issueMcpAccessToken(cookie);
    const credential = await server.pairDevice(cookie, "Legacy Test Agent");
    const agent = await startFakeAgent(credential, "legacy", { disconnectOnFirstCall: true });
    cleanups.push(() => agent.stop());
    const client = await connectMcpClient(server.baseUrl, token);
    cleanups.push(() => client.close());
    await waitFor(async () => {
      const result = await client.callTool({ name: "get_device_status", arguments: { deviceId: credential.deviceId } });
      return (result.structuredContent?.device as { state: string }).state === "READY";
    });
    const result = await client.callTool({ name: "get_config", arguments: { deviceId: credential.deviceId } });
    const error = result.structuredContent?.error as { code: string; details: { operationId: string; recovery: boolean } };
    expect(error.code).toBe("EXECUTION_UNKNOWN");
    expect(error.details.recovery).toBe(false);
    const offline = await client.callTool({ name: "odr_get_operation", arguments: { operationId: error.details.operationId } }) as QueryReply;
    expect(offline.structuredContent?.operation).toMatchObject({ resultAvailability: "offline" });
    const reconnected = await startFakeAgent(credential, "legacy-reconnected");
    cleanups.push(() => reconnected.stop());
    await waitFor(() => server.relayRegistry.get(credential.deviceId)?.state === "READY");
    const query = await client.callTool({ name: "odr_get_operation", arguments: { operationId: error.details.operationId } }) as QueryReply;
    expect(query.structuredContent?.operation).toMatchObject({ operationId: error.details.operationId, resultAvailability: "legacy" });
    expect(agent.callCount).toBe(1);
    expect(reconnected.callCount).toBe(0);
  });
});
