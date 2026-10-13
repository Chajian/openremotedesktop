import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectMcpClient,
  startTestServer,
  waitFor,
  type TestServer,
} from "./helpers/test-server.js";
import { startRealAgent } from "./helpers/test-agent.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function deviceList(result: unknown) {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent as
    | { devices?: Array<{ id: string; state: string; name: string }> }
    | undefined;
  return structured?.devices ?? [];
}

describe("real MCP -> Relay -> Agent -> Desktop Commander", () => {
  it("initializes over OAuth-protected MCP and performs file/process work", async () => {
    const server: TestServer = await startTestServer();
    cleanups.push(() => server.close());

    const cookie = await server.bootstrapAndLogin();
    const accessToken = await server.issueMcpAccessToken(cookie);
    const credential = await server.pairDevice(cookie, "E2E Real Agent");

    const workDir = mkdtempSync(join(tmpdir(), "odr-e2e-work-"));
    cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
    const filePath = resolve(workDir, "remote.txt");
    writeFileSync(filePath, "hello from e2e", "utf8");

    const agent = await startRealAgent(credential, workDir);
    cleanups.push(() => agent.stop());

    const client = await connectMcpClient(server.baseUrl, accessToken);
    cleanups.push(() => client.close());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_devices",
        "read_file",
        "write_file",
        "start_process",
        "interact_with_process",
      ]),
    );

    try {
      await waitFor(async () => {
        const listed = await client.callTool({
          name: "list_devices",
          arguments: {},
        });
        return deviceList(listed).some(
          (device) =>
            device.id === credential.deviceId && device.state === "READY",
        );
      }, 20_000);
    } catch (error) {
      const listed = await client.callTool({
        name: "list_devices",
        arguments: {},
      });
      const durable = server.db
        .prepare(
          "SELECT id, platform, agent_version AS agentVersion, desktop_commander_version AS desktopCommanderVersion, last_seen_at AS lastSeenAt FROM devices WHERE id = ?",
        )
        .get(credential.deviceId);
      throw new Error(
        `READY diagnostics: executor=${agent.executor.state()} agentFailure=${
          agent.failure instanceof Error
            ? `${agent.failure.name}: ${agent.failure.message}`
            : String(agent.failure)
        } serverErrors=${server.serverErrors
          .map((entry) => entry.stack ?? `${entry.name}: ${entry.message}`)
          .join(" | ")} devices=${JSON.stringify(
          deviceList(listed),
        )} durable=${JSON.stringify(durable)} cause=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const read = await client.callTool({
      name: "read_file",
      arguments: { path: filePath },
    });
    expect(JSON.stringify(read)).toContain("hello from e2e");

    const write = await client.callTool({
      name: "write_file",
      arguments: {
        path: filePath,
        content: "changed through remote MCP",
        mode: "rewrite",
      },
    });
    expect(write.isError).not.toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain(
      "changed through remote MCP",
    );

    const started = await client.callTool({
      name: "start_process",
      arguments: { command: "node -i", timeout_ms: 4_000 },
    });
    const startedText = JSON.stringify(started);
    const pid = /PID\D+(\d+)/i.exec(startedText)?.[1];
    expect(pid).toBeTruthy();

    const interacted = await client.callTool({
      name: "interact_with_process",
      arguments: {
        pid: Number(pid),
        input: "console.log(6 * 7)",
        timeout_ms: 4_000,
      },
    });
    expect(JSON.stringify(interacted)).toContain("42");

    await client.callTool({
      name: "interact_with_process",
      arguments: {
        pid: Number(pid),
        input: ".exit",
        timeout_ms: 2_000,
        wait_for_prompt: false,
      },
    });
  });
});
