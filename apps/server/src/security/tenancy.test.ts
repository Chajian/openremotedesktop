import { describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { OwnerRepository } from "../auth/owner-repository.js";
import { DeviceRepository, DeviceNotFoundError } from "../devices/device-repository.js";
import { OAuthClientRepository } from "../oauth/client-repository.js";

describe("per-user security boundaries", () => {
  it("requires an owner for each device and prevents cross-user management", async () => {
    const db = createDatabase(":memory:");
    try {
      const accounts = new OwnerRepository(db);
      const root = await accounts.bootstrapOwner({ password: "root-password-for-test" });
      const alice = accounts.findOrCreateGitHubUser("12345", "alice");
      const devices = new DeviceRepository(db);
      const rootDevice = devices.create("Root PC", root.id);
      const aliceDevice = devices.create("Alice PC", alice.id);
      expect(devices.listOwnedDevices(root.id).map(d => d.id)).toEqual([rootDevice.id]);
      expect(devices.listOwnedDevices(alice.id).map(d => d.id)).toEqual([aliceDevice.id]);
      expect(() => devices.renameOwnedDevice(rootDevice.id, alice.id, "STOLEN")).toThrow(DeviceNotFoundError);
      expect(() => devices.revokeOwnedDevice(rootDevice.id, alice.id)).toThrow(DeviceNotFoundError);
      expect(devices.revokeAllOwnedDevices(alice.id)).toBe(1);
      expect(devices.findById(rootDevice.id)?.revokedAt).toBeNull();
      expect(devices.findById(aliceDevice.id)?.revokedAt).not.toBeNull();
    } finally { db.close(); }
  });

  it("keeps approved OAuth grants independent for two local users", async () => {
    const db = createDatabase(":memory:");
    try {
      const accounts = new OwnerRepository(db);
      const root = await accounts.bootstrapOwner({ password: "root-password-for-test" });
      const alice = accounts.findOrCreateGitHubUser("12345", "alice");
      const clients = new OAuthClientRepository(db);
      const client = clients.create({
        redirectUris: ["https://client.example/callback"],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none",
      });
      clients.approveClient(client.clientId, root.id);
      clients.approveClient(client.clientId, alice.id);
      expect(clients.listApprovedClients(root.id)).toHaveLength(1);
      expect(clients.listApprovedClients(alice.id)).toHaveLength(1);
      expect(clients.revokeClient(client.clientId, alice.id)).toBe(true);
      expect(clients.listApprovedClients(root.id)).toHaveLength(1);
      expect(clients.listApprovedClients(alice.id)).toHaveLength(0);
    } finally { db.close(); }
  });
});
