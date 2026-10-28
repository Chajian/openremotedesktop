import {describe, expect, it} from "vitest";
import {buildApp} from "../app.js";
import {createDatabase} from "../db/database.js";
import {DeviceRepository} from "../devices/device-repository.js";
import {DeviceAuthService} from "../devices/device-auth.js";
import {OwnerRepository} from "../auth/owner-repository.js";
import {SessionRepository} from "../auth/session-repository.js";
import {ConnectionRegistry} from "../relay/connection-registry.js";
import {RequestBroker} from "../relay/request-broker.js";
import {DeviceManagementService} from "../devices/device-management-service.js";
import {SupportService} from "./support-service.js";

async function fixture(enabled = true) {
  const db = createDatabase(":memory:");
  const app = buildApp({db,config:{databasePath:":memory:",
    publicBaseUrl:new URL("https://remote.example.com"),environment:"test",supportEnabled:enabled}});
  const owners = new OwnerRepository(db);
  const owner = await owners.bootstrapOwner({password:"fixture-secret-passphrase"});
  const login = await app.inject({method:"POST",url:"/api/login",
    payload:{password:"fixture-secret-passphrase"}});
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const dispose = async () => {await app.close();db.close();};
  return {app,db,cookie,ownerId:owner.id,dispose};
}
const csrf = (html:string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const inviteFrom = (html:string) =>
  /https:\/\/remote\.example\.com\/support\/invite\/([A-Za-z0-9_-]{32})/.exec(html)?.[1] ?? "";

describe("temporary support sessions", () => {
  it("requires the feature flag and an authenticated creator", async () => {
    const f = await fixture(false);
    try {
      const page = await f.app.inject({url:"/dashboard/support",headers:{cookie:f.cookie}});
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('action="/dashboard/support/create"');
      expect((await f.app.inject({method:"POST",url:"/dashboard/support/create",
        headers:{cookie:f.cookie},payload:{csrf:csrf(page.body),label:"Disabled"}})).statusCode).toBe(404);
      expect((await f.app.inject({method:"POST",url:"/api/support/join",payload:{}})).statusCode).toBe(404);
    } finally {await f.dispose();}
  });
  it("creates an expiring invite, joins without a customer account, and ends manually", async () => {
    const f = await fixture();
    try {
      const page = await f.app.inject({url:"/dashboard/support",headers:{cookie:f.cookie}});
      expect(page.statusCode).toBe(200);
      expect((await f.app.inject({method:"POST",url:"/dashboard/support/create",
        headers:{cookie:f.cookie},payload:{csrf:"bad",label:"Customer 1"}})).statusCode).toBe(403);
      const created = await f.app.inject({method:"POST",url:"/dashboard/support/create",
        headers:{cookie:f.cookie},payload:{csrf:csrf(page.body),label:"Customer 1"}});
      expect(created.statusCode).toBe(200);
      const invite = inviteFrom(created.body);
      expect(invite).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(created.body).toContain("Invitation expires");
      const before = await f.app.inject({url:"/api/support/invite/"+invite});
      expect(before.json()).toMatchObject({label:"Customer 1",access:"full"});
      expect((await f.app.inject({url:"/support/invite/"+invite})).body).toContain("Developer preview");
      expect((await f.app.inject({method:"POST",url:"/api/support/join",
        payload:{invite,deviceName:"Customer Laptop",platform:"darwin"}})).statusCode).toBe(400);
      const joined = await f.app.inject({method:"POST",url:"/api/support/join",
        payload:{invite,deviceName:"Customer Laptop",platform:"win32"}});
      expect(joined.statusCode).toBe(201);
      const {deviceId,refreshCredential} = joined.json();
      expect((await f.app.inject({method:"POST",url:"/api/support/join",
        payload:{invite,deviceName:"Again",platform:"win32"}})).statusCode).toBe(409);
      const token = await f.app.inject({method:"POST",url:"/api/device-auth/refresh",
        payload:{refreshCredential}});
      expect(token.statusCode).toBe(200);
      expect((await f.app.inject({url:"/api/devices",headers:{cookie:f.cookie}})).json())
        .toEqual(expect.arrayContaining([expect.objectContaining({id:deviceId})]));
      const supportPage = await f.app.inject({url:"/dashboard/support",headers:{cookie:f.cookie}});
      expect(supportPage.body).toContain("Customer 1");
      expect(supportPage.body).toContain("Active");
      const sessionId = (f.db.prepare("SELECT id FROM support_sessions").get() as {id:string}).id;
      const ended = await f.app.inject({method:"POST",url:`/dashboard/support/${sessionId}/end`,
        headers:{cookie:f.cookie},payload:{csrf:csrf(supportPage.body)}});
      expect(ended.statusCode).toBe(303);
      const status = await f.app.inject({method:"POST",url:"/api/support/status",payload:{refreshCredential}});
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({state:"ended",reason:"owner"});
      expect((await f.app.inject({method:"POST",url:"/api/support/status",payload:{refreshCredential:"bad"}})).statusCode).toBe(404);
      expect((await f.app.inject({method:"POST",url:"/api/device-auth/refresh",
        payload:{refreshCredential}})).statusCode).toBe(401);
      expect((await f.app.inject({url:"/api/devices",headers:{cookie:f.cookie}})).json()).toEqual([]);
      expect((await f.app.inject({method:"POST",url:"/dashboard/support/"+sessionId+"/end",
        headers:{cookie:f.cookie},payload:{csrf:csrf(supportPage.body)}})).statusCode).toBe(303);
      const state = await f.app.inject({url:"/dashboard/support",headers:{cookie:f.cookie}});
      expect(state.body).toContain("Ended");
      expect(state.body).not.toContain(refreshCredential);
    } finally {await f.dispose();}
  });

  it("lets the customer stop sharing and prevents other owners from ending sessions", async () => {
    const f = await fixture();
    try {
      const page = await f.app.inject({url:"/dashboard/support",headers:{cookie:f.cookie}});
      const created = await f.app.inject({method:"POST",url:"/dashboard/support/create",
        headers:{cookie:f.cookie},payload:{csrf:csrf(page.body),label:"Customer 2"}});
      const invite = inviteFrom(created.body);
      const {deviceId,refreshCredential} = (await f.app.inject({method:"POST",url:"/api/support/join",
        payload:{invite,deviceName:"Laptop",platform:"win32"}})).json();
      const sessionId = (f.db.prepare("SELECT id FROM support_sessions").get() as {id:string}).id;
      const bob = new OwnerRepository(f.db).findOrCreateGitHubUser("9292","bob");
      const bobCookie = "odr_session=" + new SessionRepository(f.db).createOwnerSession(bob.id);
      const bobPage = await f.app.inject({url:"/dashboard/support",headers:{cookie:bobCookie}});
      expect(bobPage.body).not.toContain("Customer 2");
      expect((await f.app.inject({method:"POST",url:`/dashboard/support/${sessionId}/end`,
        headers:{cookie:bobCookie},payload:{csrf:csrf(bobPage.body)}})).statusCode).toBe(404);
      expect((await f.app.inject({method:"POST",url:"/api/support/stop",
        payload:{refreshCredential:"wrong"}})).statusCode).toBe(404);
      expect((await f.app.inject({method:"POST",url:"/api/support/stop",
        payload:{refreshCredential}})).statusCode).toBe(204);
      expect(new DeviceRepository(f.db).findById(deviceId)).toBeNull();
      expect((await f.app.inject({method:"POST",url:"/api/support/status",
        payload:{refreshCredential}})).json()).toEqual({state:"ended",reason:"customer"});
      expect((await f.app.inject({method:"POST",url:"/api/support/stop",
        payload:{refreshCredential}})).statusCode).toBe(404);
    } finally {await f.dispose();}
  });

  it("does not expire a joined session when the invitation TTL passes", () => {
    const db = createDatabase(":memory:");
    try {
      db.prepare("INSERT INTO owner (id,password_hash,created_at) VALUES ('owner','fixture',0)").run();
      const devices = new DeviceRepository(db);
      const registry = new ConnectionRegistry();
      const management = new DeviceManagementService(devices,registry,new RequestBroker(registry));
      let now = 123456789;
      const service = new SupportService(db,devices,management,()=>now);
      const {invite} = service.create("owner","Support");
      now += 60_000;
      service.join(invite,"Customer PC","win32");
      now += 24*60*60*1000;
      expect(service.listOwned("owner")[0]?.state).toBe("active");
      expect(service.endOwned(service.listOwned("owner")[0]!.id,"owner")).toBe(true);
      expect(service.listOwned("owner")[0]?.state).toBe("ended");
    } finally {db.close();}
  });
});

describe("focused active-support and transactional boundaries", () => {
  it("queries only live, owned support and permits ending with issuance disabled", async () => {
    const f = await fixture(false);
    try {
      const devices = new DeviceRepository(f.db);
      const registry = new ConnectionRegistry();
      const service = new SupportService(f.db, devices,
        new DeviceManagementService(devices, registry, new RequestBroker(registry)));
      const bob = new OwnerRepository(f.db).findOrCreateGitHubUser("96582", "other");
      const own = service.create(f.ownerId, "Ongoing");
      const foreign = service.create(bob.id, "Foreign");
      const a = service.join(own.invite, "Windows A", "win32");
      const b = service.join(foreign.invite, "Windows B", "win32");
      expect(service.hasActiveSupport(f.ownerId)).toBe(true);
      expect(service.activeDeviceIds(f.ownerId)).toEqual([a.deviceId]);
      expect(service.activeDeviceIds(bob.id)).toEqual([b.deviceId]);
      const dashboard = await f.app.inject({url:"/dashboard/support",headers:{cookie:f.cookie}});
      expect(dashboard.body).toContain("Ongoing");
      expect(dashboard.body).not.toContain("Foreign");
      expect(dashboard.body).toContain("End support");
      service.endOwned(own.session.id, f.ownerId);
      expect(service.hasActiveSupport(f.ownerId)).toBe(false);
      expect(service.activeDeviceIds(f.ownerId)).toEqual([]);
      expect(service.hasActiveSupport(bob.id)).toBe(true);
      devices.deleteOwnedDevice(b.deviceId, bob.id);
      expect(service.hasActiveSupport(bob.id)).toBe(false);
      expect(service.activeDeviceIds(bob.id)).toEqual([]);
    } finally { await f.dispose(); }
  });
  it("rolls back device and credential if invitation binding fails", () => {
    const db = createDatabase(":memory:");
    try {
      db.prepare("INSERT INTO owner (id,password_hash,created_at) VALUES ('owner','x',0)").run();
      const devices = new DeviceRepository(db);
      const registry = new ConnectionRegistry();
      const service = new SupportService(db, devices,
        new DeviceManagementService(devices, registry, new RequestBroker(registry)));
      const { invite, session } = service.create("owner","Rollback fixture");
      db.exec(`CREATE TRIGGER reject_support_join BEFORE UPDATE OF device_id ON support_sessions
        BEGIN SELECT RAISE(ABORT, 'fixture binding failed'); END`);
      expect(() => service.join(invite,"Windows", "win32")).toThrow();
      expect(devices.listDevices()).toHaveLength(0);
      expect(db.prepare("SELECT COUNT(*) AS n FROM device_credentials").get()).toEqual({n:0});
      expect(db.prepare("SELECT device_id AS deviceId, joined_at AS joinedAt FROM support_sessions WHERE id=?")
        .get(session.id)).toEqual({deviceId:null,joinedAt:null});
      db.exec("DROP TRIGGER reject_support_join");
      expect(service.join(invite,"Windows", "win32").deviceId).toBeTruthy();
      expect(devices.listDevices()).toHaveLength(1);
    } finally { db.close(); }
  });
});
