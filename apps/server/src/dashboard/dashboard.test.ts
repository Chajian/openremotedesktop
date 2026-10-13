import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { DeviceRepository } from "../devices/device-repository.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odr-dashboard-"));
  const databasePath = join(dir, "server.sqlite");
  const db = createDatabase(databasePath);
  const app = buildApp({
    db,
    config: {
      databasePath,
      publicBaseUrl: new URL("https://remote.example.com"),
      environment: "test",
    },
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await app.inject({
    method: "POST",
    url: "/api/bootstrap",
    payload: { password: "old-test-passphrase-123" },
  });

  async function login(password = "old-test-passphrase-123") {
    const response = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password },
    });
    return {
      response,
      cookie: String(response.headers["set-cookie"] ?? "").split(";")[0]!,
    };
  }
  return { app, db, login };
}

function csrfFrom(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("csrf field missing");
  return match[1]!;
}

describe("multi-account sign-out", () => {
  it("invalidates only the current session and clears its cookie", async () => {
    const { app, db, login } = await fixture();
    const first = await login();
    const other = await login();
    const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie: first.cookie } });
    const csrf = csrfFrom(page.body);
    const logout = await app.inject({
      method: "POST", url: "/dashboard/logout",
      headers: { cookie: first.cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: "csrf=" + encodeURIComponent(csrf),
    });
    expect(logout.statusCode).toBe(303);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    const firstAfter = await app.inject({method:"GET",url:"/dashboard",headers:{cookie:first.cookie}});
    expect(firstAfter.statusCode).toBe(302);
    const secondAfter = await app.inject({method:"GET",url:"/dashboard",headers:{cookie:other.cookie}});
    expect(secondAfter.statusCode).toBe(200);
  });
});

describe("Owner Dashboard", () => {
  it("redirects unauthenticated admin pages to the dashboard login", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/dashboard" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/dashboard/login");
  });

  it("renders owned device metadata without exposing pending pairing codes", async () => {
    const { app, db, login } = await fixture();
    const { cookie } = await login();
    const devices = new DeviceRepository(db);
    const device = devices.create("<b>unsafe name</b>", (db.prepare("SELECT id FROM owner WHERE auth_source = 'local'").get() as {id:string}).id);
    devices.updateRuntimeMetadata(device.id, {
      platform: "win32",
      agentVersion: "0.1.0",
      desktopCommanderVersion: "0.2.52",
    }, 1234);
    const pairing = await app.inject({
      method: "POST",
      url: "/api/device-pairings",
    });

    const response = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(device.id.slice(0, 8));
    expect(response.body).toContain("win32");
    expect(response.body).toContain("0.1.0");
    expect(response.body).toContain("0.2.52");
    expect(response.body).toContain("OFFLINE");
    expect(response.body).not.toContain(pairing.json().userCode);
    expect(response.body).toContain("Pair a computer");
    expect(response.body).not.toContain("<b>unsafe name</b>");
    expect(response.body).toContain("&lt;b&gt;unsafe name&lt;/b&gt;");
  });
  it("requires CSRF and can rename/revoke a device", async () => {
    const { app, db, login } = await fixture();
    const { cookie } = await login();
    const devices = new DeviceRepository(db);
    const device = devices.create("Game PC", (db.prepare("SELECT id FROM owner WHERE auth_source = 'local'").get() as {id:string}).id);

    const noCsrf = await app.inject({
      method: "POST",
      url: `/dashboard/devices/${device.id}/rename`,
      headers: { cookie },
      payload: { name: "Renamed" },
    });
    expect(noCsrf.statusCode).toBe(403);

    const page = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    const csrf = csrfFrom(page.body);
    const renamed = await app.inject({
      method: "POST",
      url: `/dashboard/devices/${device.id}/rename`,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `csrf=${encodeURIComponent(csrf)}&name=Renamed`,
    });
    expect(renamed.statusCode).toBe(303);
    expect(devices.findById(device.id)?.name).toBe("Renamed");
    const revoked = await app.inject({
      method: "POST",
      url: `/dashboard/devices/${device.id}/revoke`,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(revoked.statusCode).toBe(303);
    expect(devices.findById(device.id)?.revokedAt).not.toBeNull();
  });

  it("approves a pending pairing from the dashboard", async () => {
    const { app, db, login } = await fixture();
    const { cookie } = await login();
    const pairingResponse = await app.inject({
      method: "POST",
      url: "/api/device-pairings",
    });
    const pairing = pairingResponse.json();
    const page = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    const csrf = csrfFrom(page.body);

    const approved = await app.inject({
      method: "POST",
      url: `/dashboard/pairings/${pairing.userCode}/approve`,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `csrf=${encodeURIComponent(csrf)}&friendlyName=Game%20PC`,
    });
    expect(approved.statusCode).toBe(303);
    expect(new DeviceRepository(db).listDevices()[0]?.name).toBe("Game PC");
  });
  it("shows MCP URL and rotates the owner passphrase while invalidating other sessions", async () => {
    const { app, login } = await fixture();
    const first = await login();
    const second = await login();

    const mcp = await app.inject({
      method: "GET",
      url: "/dashboard/mcp",
      headers: { cookie: first.cookie },
    });
    expect(mcp.body).toContain("https://remote.example.com/mcp");
    expect(mcp.body).toMatch(/OAuth/i);

    const page = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie: first.cookie },
    });
    const csrf = csrfFrom(page.body);
    const changed = await app.inject({
      method: "POST",
      url: "/dashboard/password",
      headers: {
        cookie: first.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload:
        `csrf=${encodeURIComponent(csrf)}&currentPassword=old-test-passphrase-123&newPassword=new-test-passphrase-456`,
    });
    expect(changed.statusCode).toBe(303);
    expect((await login("old-test-passphrase-123")).response.statusCode).toBe(401);
    expect((await login("new-test-passphrase-456")).response.statusCode).toBe(204);

    const staleSession = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie: second.cookie },
    });
    expect(staleSession.statusCode).toBe(302);

    const currentSession = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie: first.cookie },
    });
    expect(currentSession.statusCode).toBe(200);
  });
});
