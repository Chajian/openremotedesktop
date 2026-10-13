import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectMcpClient,
  startTestServer,
  waitFor,
} from "./helpers/test-server.js";
import {
  startFakeAgent,
  startRealAgent,
} from "./helpers/test-agent.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function states(result: unknown) {
  return (
    (result as {
      structuredContent?: {
        devices?: Array<{ id: string; state: string; name: string }>;
      };
    }).structuredContent?.devices ?? []
  );
}

async function stateFor(
  client: Awaited<ReturnType<typeof connectMcpClient>>,
  deviceId: string,
) {
  const result = await client.callTool({
    name: "list_devices",
    arguments: {},
  });
  return states(result).find((device) => device.id === deviceId)?.state;
}

describe("relay reconnect and durable device state", () => {
  it("reconnects a real Agent after a relay socket drop without pairing again", async () => {
    const server = await startTestServer();
    cleanups.push(() => server.close());
    const cookie = await server.bootstrapAndLogin();
    const token = await server.issueMcpAccessToken(cookie);
    const credential = await server.pairDevice(cookie, "Reconnect Agent");

    const cwd = mkdtempSync(join(tmpdir(), "odr-e2e-reconnect-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const agent = await startRealAgent(credential, cwd);
    cleanups.push(() => agent.stop());
    const client = await connectMcpClient(server.baseUrl, token);
    cleanups.push(() => client.close());

    await waitFor(
      async () => (await stateFor(client, credential.deviceId)) === "READY",
      20_000,
    );

    agent.dropConnection();

    await waitFor(
      async () => (await stateFor(client, credential.deviceId)) !== "READY",
      5_000,
    );
    await waitFor(
      async () => (await stateFor(client, credential.deviceId)) === "READY",
      20_000,
    );

    expect(agent.failure).toBeUndefined();
  });

  it("preserves registration across Server restart but starts live state OFFLINE", async () => {
    const first = await startTestServer();
    const dataDir = first.dataDir;
    const databasePath = first.databasePath;
    const port = first.port;
    const cookie = await first.bootstrapAndLogin();
    const token = await first.issueMcpAccessToken(cookie);
    const credential = await first.pairDevice(cookie, "Durable Device");
    const fake = await startFakeAgent(credential, "before-restart");

    const firstClient = await connectMcpClient(first.baseUrl, token);
    await waitFor(
      async () => (await stateFor(firstClient, credential.deviceId)) === "READY",
      10_000,
    );

    await fake.stop();
    await firstClient.close();
    await first.close(false);

    const second = await startTestServer({ databasePath, port });
    cleanups.push(async () => {
      await second.close(false);
      rmSync(dataDir, { recursive: true, force: true });
    });
    const secondClient = await connectMcpClient(second.baseUrl, token);
    cleanups.push(() => secondClient.close());

    expect(await stateFor(secondClient, credential.deviceId)).toBe("OFFLINE");

    const reconnected = await startFakeAgent(credential, "after-restart");
    cleanups.push(() => reconnected.stop());
    await waitFor(
      async () => (await stateFor(secondClient, credential.deviceId)) === "READY",
      10_000,
    );
  });
});
