import { afterEach, describe, expect, it } from "vitest";
import { startFakeAgent, startRealAgent } from "./helpers/test-agent.js";
import { connectMcpClient, startTestServer, waitFor } from "./helpers/test-server.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

describe("mixed Desktop Commander catalog compatibility", () => {
  it("keeps a hash-less 0.2.52 Agent READY beside a validated real 0.3.1 Agent", async () => {
    const server = await startTestServer();
    cleanups.push(() => server.close());
    const cookie = await server.bootstrapAndLogin();
    const token = await server.issueMcpAccessToken(cookie);
    const legacyCredential = await server.pairDevice(cookie, "Legacy catalog fixture");
    const currentCredential = await server.pairDevice(cookie, "Current catalog fixture");
    const directory = await mkdtemp(join(tmpdir(), "odr-catalog-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    // The old-frame fixture tests Server compatibility, while the current
    // device uses the actual pinned subprocess and strict catalog validation.
    const legacy = await startFakeAgent(legacyCredential, "legacy", { desktopCommanderVersion: "0.2.52" });
    cleanups.push(() => legacy.stop());
    const current = await startRealAgent(currentCredential, directory);
    cleanups.push(() => current.stop());
    const client = await connectMcpClient(server.baseUrl, token);
    cleanups.push(() => client.close());
    await waitFor(() => [legacyCredential, currentCredential].every(
      credential => server.relayRegistry.get(credential.deviceId)?.state === "READY",
    ), 20_000);
    const listed = await client.callTool({ name: "list_devices", arguments: {} });
    expect(listed.structuredContent?.devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: legacyCredential.deviceId, desktopCommanderVersion: "0.2.52", state: "READY" }),
      expect.objectContaining({ id: currentCredential.deviceId, desktopCommanderVersion: "0.3.1", state: "READY" }),
    ]));
    for (const credential of [legacyCredential, currentCredential]) {
      const result = await client.callTool({ name: "get_config", arguments: { deviceId: credential.deviceId } });
      expect(result.isError).not.toBe(true);
    }
    const search = await client.callTool({ name: "start_search", arguments: {
      deviceId: legacyCredential.deviceId, path: "/fixture", pattern: "needle", maxResults: 0, contextLines: 0,
    } });
    expect(search.isError).not.toBe(true);
    expect(search.structuredContent).toMatchObject({ label: "legacy", arguments: { maxResults: 0, contextLines: 0 } });
    expect(legacy.callCount).toBe(2);
    expect((await client.listTools()).tools.some(tool => tool.name === "get_prompts")).toBe(false);
  });
});
