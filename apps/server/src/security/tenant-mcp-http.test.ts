import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { OwnerRepository } from "../auth/owner-repository.js";
import { DeviceRepository } from "../devices/device-repository.js";
import { OAuthClientRepository } from "../oauth/client-repository.js";

function unpack(payload: string) {
  const line = payload.split(/\r?\n/).find(s => s.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : payload) as {result?: {structuredContent?: unknown}; error?: unknown};
}

describe("MCP HTTP user context", () => {
  it("propagates bearer token owner through HTTP to list_devices and routing", async () => {
    const db = createDatabase(":memory:");
    const app = buildApp({db, config: {
      databasePath: ":memory:", publicBaseUrl: new URL("https://remote.example.com"), environment: "test",
    }});
    try {
      const users = new OwnerRepository(db);
      const alice = users.findOrCreateGitHubUser("101", "alice");
      const bob = users.findOrCreateGitHubUser("202", "bob");
      const device = new DeviceRepository(db).create("BobsPrivatePC", bob.id);
      const clients = new OAuthClientRepository(db);
      const client = clients.create({
        redirectUris: ["https://client.example/cb"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
      });
      clients.approveClient(client.clientId, alice.id);
      clients.approveClient(client.clientId, bob.id);
      function issueToken(ownerId: string) {
        const raw = "e2e-" + ownerId;
        db.prepare(
          "INSERT INTO oauth_tokens (id,token_type,token_hash,client_id,owner_id,resource,scope,expires_at,revoked_at,parent_id) " +
          "VALUES (?, 'access', ?, ?, ?, 'https://remote.example.com/mcp', 'mcp', ?, NULL, NULL)"
        ).run(raw, createHash("sha256").update(raw).digest("hex"), client.clientId, ownerId, Date.now() + 60000);
        return raw;
      }
      async function call(rawToken: string, id: number, name: string, args: Record<string, unknown> = {}) {
        const response = await app.inject({
          method: "POST", url: "/mcp",
          headers: { authorization: "Bearer " + rawToken, accept: "application/json, text/event-stream", "content-type": "application/json" },
          payload: {jsonrpc: "2.0", id, method: "tools/call", params: {name, arguments: args}},
        });
        expect(response.statusCode).toBe(200);
        return unpack(response.payload);
      }
      const aToken = issueToken(alice.id);
      const bToken = issueToken(bob.id);
      const aliceResult = await call(aToken, 1, "list_devices");
      const bobResult = await call(bToken, 2, "list_devices");
      expect(JSON.stringify(aliceResult)).not.toContain("BobsPrivatePC");
      expect(JSON.stringify(bobResult)).toContain("BobsPrivatePC");
      const blocked = await call(aToken, 3, "get_config", { deviceId: device.id });
      expect(JSON.stringify(blocked)).toContain("DEVICE_NOT_FOUND");
    } finally {
      await app.close();
      db.close();
    }
  });
});
