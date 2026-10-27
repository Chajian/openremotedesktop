import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { OwnerRepository } from "../auth/owner-repository.js";
import { SessionRepository } from "../auth/session-repository.js";
import { ConnectionRegistry } from "../relay/connection-registry.js";
import { RequestBroker } from "../relay/request-broker.js";
import { DeviceAuthService } from "./device-auth.js";
import { DeviceManagementService } from "./device-management-service.js";
import { DeviceRepository, DeviceNotFoundError } from "./device-repository.js";
import { PairingService } from "./pairing-service.js";

describe("device deletion", () => {
  it("revokes refresh/access tokens, scrubs data and is owner-idempotent", () => {
    const db = createDatabase(":memory:");
    try {
      db.prepare("INSERT INTO owner (id,password_hash,created_at) VALUES ('alice','x',0),('bob','x',0)").run();
      const devices = new DeviceRepository(db);
      const pairs = new PairingService(db, devices, new URL("https://remote.example.com"));
      const pair = pairs.createPairing();
      const device = pairs.approvePairing(pair.userCode, "Customer PC", "alice");
      const poll = pairs.pollPairing(pair.deviceCode);
      if (poll.status !== "approved") throw new Error("expected approved pairing");
      const auth = new DeviceAuthService(db, devices);
      const token = auth.refreshDeviceAccess(poll.refreshCredential);
      expect(() => devices.deleteOwnedDevice(device.id, "bob")).toThrow(DeviceNotFoundError);
      expect(devices.deleteOwnedDevice(device.id, "alice")).toBe(true);
      expect(devices.deleteOwnedDevice(device.id, "alice")).toBe(false);
      expect(devices.listOwnedDevices("alice")).toEqual([]);
      expect(devices.findById(device.id)).toBeNull();
      expect(() => auth.refreshDeviceAccess(poll.refreshCredential)).toThrow();
      expect(() => auth.verifyDeviceAccess(token.accessToken)).toThrow();
      const record = db.prepare("SELECT name, platform, deleted_at AS deletedAt FROM devices WHERE id = ?").get(device.id) as { name: string; platform: string | null; deletedAt: number };
      expect(record.name).toBe("Deleted device");
      expect(record.platform).toBeNull();
      expect(record.deletedAt).toBeGreaterThan(0);
      expect(db.prepare("SELECT COUNT(*) AS count FROM device_deletion_events").get()).toMatchObject({count: 1});
      expect(devices.pruneDeletionAudit(30, record.deletedAt + 31 * 86_400_000)).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM device_deletion_events").get()).toMatchObject({count: 0});
      expect(devices.listDevices()).toEqual([]);
    } finally { db.close(); }
  });

  it("immediately disconnects a READY socket and marks a dispatched request unknown", async () => {
    const db = createDatabase(":memory:");
    try {
      db.prepare("INSERT INTO owner (id,password_hash,created_at) VALUES ('alice','x',0)").run();
      const devices = new DeviceRepository(db);
      const device = devices.create("Online PC", "alice");
      const socket = { send: vi.fn(), close: vi.fn(), terminate: vi.fn() } as unknown as WebSocket;
      const registry = new ConnectionRegistry();
      registry.attach(device.id, socket);
      registry.markAuthenticated(device.id, socket);
      registry.markExecutorState(device.id, socket, "READY");
      const broker = new RequestBroker(registry);
      const service = new DeviceManagementService(devices, registry, broker);
      const pending = broker.call(device.id, "write_file", {path: "fixture"}, {timeoutMs: 4000});
      expect(service.deleteOwnedDevice(device.id, "alice")).toBe(true);
      await expect(pending).rejects.toMatchObject({code: "EXECUTION_UNKNOWN"});
      expect(registry.get(device.id)).toBeUndefined();
      expect(socket.close).toHaveBeenCalledWith(4003, "Device removed by owner");
      await expect(broker.call(device.id, "write_file", {}, {timeoutMs: 1000})).rejects.toMatchObject({code: "DEVICE_OFFLINE"});
    } finally { db.close(); }
  });

  it("requires account ownership and rejects cross-origin API deletes", async () => {
    const db = createDatabase(":memory:");
    const app = buildApp({db, config:{databasePath:":memory:", publicBaseUrl:new URL("https://remote.example.com"), environment:"test"}});
    try {
      const owners = new OwnerRepository(db);
      const alice = await owners.bootstrapOwner({password:"secret-12345678"});
      const bob = owners.findOrCreateGitHubUser("2222", "bob");
      const own = new DeviceRepository(db).create("Only Alice", alice.id);
      const other = new DeviceRepository(db).create("Only Bob", bob.id);
      const login = await app.inject({method:"POST", url:"/api/login", payload:{password:"secret-12345678"}});
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const sessions = new SessionRepository(db);
      const bobCookie = "odr_session=" + sessions.createOwnerSession(bob.id);
      const url = "/api/devices/" + own.id;
      expect((await app.inject({method:"DELETE",url})).statusCode).toBe(401);
      expect((await app.inject({method:"DELETE",url,headers:{cookie:bobCookie}})).statusCode).toBe(404);
      expect((await app.inject({method:"DELETE",url,headers:{cookie,origin:"https://evil.example"}})).statusCode).toBe(403);
      expect((await app.inject({method:"DELETE",url,headers:{cookie}})).statusCode).toBe(204);
      expect((await app.inject({method:"DELETE",url,headers:{cookie}})).statusCode).toBe(204);
      const devices = new DeviceRepository(db);
      expect(devices.findById(own.id)).toBeNull();
      expect(devices.findById(other.id)).not.toBeNull();
      expect((await app.inject({method:"GET",url:"/api/devices",headers:{cookie}})).json()).toEqual([]);
      expect((await app.inject({method:"PATCH",url,payload:{name:"again"},headers:{cookie}})).statusCode).toBe(404);
    } finally {await app.close(); db.close();}
  });
});
