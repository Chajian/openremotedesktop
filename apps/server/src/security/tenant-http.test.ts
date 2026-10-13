import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { OwnerRepository } from "../auth/owner-repository.js";
import { SessionRepository } from "../auth/session-repository.js";
import { DeviceRepository } from "../devices/device-repository.js";

describe("tenant boundaries at HTTP entrypoints", () => {
  it("enforces owner scoping for dashboard, device APIs, revoke-all and pairing", async () => {
    const db = createDatabase(":memory:");
    const app = buildApp({
      db,
      config: { databasePath: ":memory:", publicBaseUrl: new URL("https://remote.example.com"), environment: "test" },
    });
    try {
      const users = new OwnerRepository(db);
      await users.bootstrapOwner({ password: "legacy-root-test" });
      const alice = users.findOrCreateGitHubUser("101", "alice");
      const bob = users.findOrCreateGitHubUser("202", "bob");
      const sessions = new SessionRepository(db);
      const aliceCookie = "odr_session=" + sessions.createOwnerSession(alice.id);
      const bobCookie = "odr_session=" + sessions.createOwnerSession(bob.id);
      const devices = new DeviceRepository(db);
      const aliceDevice = devices.create("OnlyAlice", alice.id);
      const bobDevice = devices.create("OnlyBob", bob.id);
      const aliceList = await app.inject({method: "GET", url: "/api/devices", headers: {cookie: aliceCookie}});
      expect(aliceList.statusCode).toBe(200);
      expect(aliceList.json().map((x: {name:string}) => x.name)).toEqual(["OnlyAlice"]);
      const aliceDashboard = await app.inject({method: "GET", url: "/dashboard", headers: {cookie: aliceCookie}});
      expect(aliceDashboard.body).toContain("OnlyAlice");
      expect(aliceDashboard.body).not.toContain("OnlyBob");
      expect(aliceDashboard.body).not.toContain("Change passphrase");

      const patchBob = await app.inject({method: "PATCH", url: "/api/devices/" + bobDevice.id, headers: {cookie: aliceCookie}, payload: {name: "Hacked"}});
      expect(patchBob.statusCode).toBe(404);
      expect(devices.findById(bobDevice.id)?.name).toBe("OnlyBob");
      const revokeBob = await app.inject({method: "POST", url: "/api/devices/" + bobDevice.id + "/revoke", headers: {cookie: aliceCookie}});
      expect(revokeBob.statusCode).toBe(404);
      expect(devices.findById(bobDevice.id)?.revokedAt).toBeNull();
      const revokeAll = await app.inject({method: "POST", url: "/api/devices/revoke-all", headers: {cookie: aliceCookie}});
      expect(revokeAll.statusCode).toBe(200);
      expect(devices.findById(aliceDevice.id)?.revokedAt).not.toBeNull();
      expect(devices.findById(bobDevice.id)?.revokedAt).toBeNull();

      const pairing = (await app.inject({method: "POST", url: "/api/device-pairings"})).json();
      const bobDashboard = await app.inject({method: "GET", url: "/dashboard", headers: {cookie: bobCookie}});
      expect(bobDashboard.body).not.toContain(pairing.userCode);
      const approved = await app.inject({
        method: "POST",
        url: "/api/device-pairings/" + pairing.userCode + "/approve",
        headers: {cookie: bobCookie},
        payload: {friendlyName: "Bobs new desktop"},
      });
      expect(approved.statusCode).toBe(200);
      const newDevice = devices.findById(approved.json().deviceId);
      expect(newDevice?.ownerId).toBe(bob.id);
      expect(devices.listOwnedDevices(alice.id).some(d => d.id === newDevice?.id)).toBe(false);
    } finally {
      await app.close();
      db.close();
    }
  });
});
