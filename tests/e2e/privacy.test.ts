import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectMcpClient,
  startTestServer,
  waitFor,
} from "./helpers/test-server.js";
import { startFakeAgent } from "./helpers/test-agent.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()?.();
});

function listedDevices(result: unknown) {
  return (
    (result as {
      structuredContent?: {
        devices?: Array<{ id: string; state: string }>;
      };
    }).structuredContent?.devices ?? []
  );
}

describe("privacy defaults", () => {
  it("does not persist or normally log tool payloads or raw access tokens", async () => {
    const server = await startTestServer();
    cleanups.push(() => server.close());
    const cookie = await server.bootstrapAndLogin();
    const accessToken = await server.issueMcpAccessToken(cookie);
    const credential = await server.pairDevice(cookie, "Privacy Agent");
    const fake = await startFakeAgent(credential, "privacy");
    cleanups.push(() => fake.stop());
    const client = await connectMcpClient(server.baseUrl, accessToken);
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

    const logLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    });

    const marker = "ODR_PRIVATE_PAYLOAD_MARKER_7daec8f4";
    const result = await client.callTool({
      name: "write_file",
      arguments: {
        deviceId: credential.deviceId,
        path: "C:/privacy-marker.txt",
        content: marker,
        mode: "rewrite",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain(marker);

    expect(logLines.join("\n")).not.toContain(marker);
    expect(logLines.join("\n")).not.toContain(accessToken);
    expect(logLines.join("\n")).not.toContain(credential.refreshCredential);

    server.db.pragma("wal_checkpoint(TRUNCATE)");
    const databaseBytes = readFileSync(server.databasePath);
    expect(databaseBytes.includes(Buffer.from(marker))).toBe(false);
    expect(databaseBytes.includes(Buffer.from(accessToken))).toBe(false);
    expect(
      databaseBytes.includes(Buffer.from(credential.refreshCredential)),
    ).toBe(false);
  });
});
