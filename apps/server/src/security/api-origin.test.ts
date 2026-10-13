import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { OwnerRepository } from "../auth/owner-repository.js";
import { DeviceRepository } from "../devices/device-repository.js";

describe("cookie-backed API origin defense", () => {
  it("rejects cross-origin device mutation and leaves device authorized", async () => {
    const db = createDatabase(":memory:");
    const app = buildApp({ db, config: {
      databasePath: ":memory:", publicBaseUrl: new URL("https://remote.example.com"), environment: "test",
    }});
    try {
      const owner = await new OwnerRepository(db).bootstrapOwner({password: "local-secret"});
      const login = await app.inject({method:"POST",url:"/api/login",payload:{password:"local-secret"}});
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const device = new DeviceRepository(db).create("My PC",owner.id);
      const attack = await app.inject({method: "POST", url: "/api/devices/" + device.id + "/revoke",
        headers: {cookie, origin:"https://evil.example", "sec-fetch-site":"cross-site"}});
      expect(attack.statusCode).toBe(403);
      expect(new DeviceRepository(db).findById(device.id)?.revokedAt).toBeNull();

      const sameOrigin = await app.inject({method: "POST",url: "/api/devices/" + device.id + "/revoke",
        headers: {cookie, origin:"https://remote.example.com", "sec-fetch-site":"same-origin"}});
      expect(sameOrigin.statusCode).toBe(200);
      expect(new DeviceRepository(db).findById(device.id)?.revokedAt).not.toBeNull();
    } finally {await app.close();db.close();}
  });

  it("rejects login POST from an unrelated origin before checking credentials", async () => {
    const db = createDatabase(":memory:");
    const app = buildApp({ db, config: {
      databasePath: ":memory:", publicBaseUrl: new URL("https://remote.example.com"), environment: "test",
    }});
    try {
      await new OwnerRepository(db).bootstrapOwner({password: "local-secret"});
      const response = await app.inject({method:"POST",url:"/api/login",headers:{origin:"https://evil.example","sec-fetch-site":"cross-site"},
        payload:{password:"local-secret"}});
      expect(response.statusCode).toBe(403);
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally {await app.close();db.close();}
  });
});
