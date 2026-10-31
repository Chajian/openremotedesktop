import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { DeviceRepository } from "../devices/device-repository.js";
import { AGENT_INSTALL_VERSION } from "./installer.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(agentInstallEnabled = false) {
  const dir = mkdtempSync(join(tmpdir(), "odr-dashboard-"));
  const databasePath = join(dir, "server.sqlite");
  const db = createDatabase(databasePath);
  const app = buildApp({
    db,
    config: {
      databasePath,
      publicBaseUrl: new URL("https://remote.example.com"),
      environment: "test",
      agentInstallEnabled,
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

function pairingFormAction(html: string): string {
  const match = /<form[^>]*action="([^"]+)"[^>]*>(?:(?!<\/form>)[\s\S])*name="userCode"/.exec(html);
  if (!match) throw new Error("pairing form missing");
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
    expect(response.body).toContain(`data-device-id="${device.id}"`);
    expect(response.body).toContain('data-state="OFFLINE"');
    const detail = await app.inject({ method: "GET", url: `/dashboard/devices/${device.id}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("win32");
    expect(detail.body).toContain("0.1.0");
    expect(detail.body).toContain("0.2.52");
    expect(response.body).toContain("OFFLINE");
    expect(response.body).not.toContain(pairing.json().userCode);
    expect(response.body).toContain('href="/dashboard/connect"');
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

  it("approves a pairing code submitted through the rendered pairing form", async () => {
    const { app, db, login } = await fixture();
    const { cookie } = await login();
    const pairing = (await app.inject({ method: "POST", url: "/api/device-pairings" })).json();
    const page = await app.inject({ method: "GET", url: "/dashboard/connect?step=3", headers: { cookie } });
    const action = pairingFormAction(page.body);

    const approved = await app.inject({
      method: "POST",
      url: action,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `csrf=${encodeURIComponent(csrfFrom(page.body))}&userCode=${pairing.userCode}&friendlyName=Game%20PC`,
    });
    expect(approved.statusCode).toBe(303);
    expect(approved.headers.location).toMatch(/^\/dashboard\/devices\/[0-9a-f-]+$/);
    expect(new DeviceRepository(db).listDevices()[0]?.name).toBe("Game PC");
  });

  it("rejects the rendered pairing form without a CSRF token", async () => {
    const { app, db, login } = await fixture();
    const { cookie } = await login();
    const pairing = (await app.inject({ method: "POST", url: "/api/device-pairings" })).json();
    const page = await app.inject({ method: "GET", url: "/dashboard/connect?step=3", headers: { cookie } });

    const rejected = await app.inject({
      method: "POST",
      url: pairingFormAction(page.body),
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `userCode=${pairing.userCode}&friendlyName=Game%20PC`,
    });
    expect(rejected.statusCode).toBe(403);
    expect(new DeviceRepository(db).listDevices()).toHaveLength(0);
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
      url: "/dashboard/settings",
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
    expect(changed.headers.location).toBe("/dashboard/settings?saved=password");
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


describe("one-command onboarding", () => {
  it("gates public installers until the reviewed npm release is available", async () => {
    const { app, login } = await fixture();
    const { cookie } = await login();
    expect((await app.inject({ url: "/install/windows.ps1" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/install/macos.sh" })).statusCode).toBe(404);
    const page = await app.inject({ url: "/dashboard/connect?step=2&os=win", headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("一键安装尚未启用");
    expect(page.body).not.toContain("Installer checksum mismatch");
  });

  it("serves hash-pinned Windows and macOS scripts from the configured HTTPS origin", async () => {
    const { app, login } = await fixture(true);
    const { cookie } = await login();
    for (const [os, endpoint] of [["win", "/install/windows.ps1"], ["mac", "/install/macos.sh"]] as const) {
      const script = await app.inject({ url: endpoint });
      expect(script.statusCode).toBe(200);
      expect(script.headers["cache-control"]).toBe("no-store");
      expect(script.body).toContain(`open-desktop-remote-agent@${AGENT_INSTALL_VERSION}`);
      expect(script.body).toContain("registry.npmjs.org");
      const page = await app.inject({ url: "/dashboard/connect?step=2&os=" + os, headers: { cookie } });
      const { createHash } = await import("node:crypto");
      expect(page.body).toContain(createHash("sha256").update(script.rawPayload).digest("hex"));
      expect(page.body).toContain(endpoint);
      expect(page.body).toContain("复制命令");
      const accelerated = await app.inject({ url: "/dashboard/connect?step=2&os=" + os + "&downloadSource=npmmirror", headers: { cookie } });
      expect(accelerated.body).toContain(os === "win" ? "-DownloadSource" : "--download-source");
      expect(accelerated.body).toContain(createHash("sha256").update(script.rawPayload).digest("hex"));
      const invalidSource = await app.inject({ url: "/dashboard/connect?step=2&os=" + os + "&downloadSource=https%3A%2F%2Fevil.test", headers: { cookie } });
      expect(invalidSource.body).not.toContain("evil.test");
      expect(invalidSource.body).not.toContain(os === "win" ? "-DownloadSource" : "--download-source");
    }
    expect((await app.inject({ url: "/dashboard/onboarding.js" })).body).toContain("setInterval(poll, 2500)");
  });

  it("prefills short-lived code but never authorizes until a CSRF-protected POST", async () => {
    const { app, db, login } = await fixture(true);
    const pairing = (await app.inject({ method: "POST", url: "/api/device-pairings" })).json();
    const noSession = await app.inject({ url: "/device?code=" + pairing.userCode });
    expect(noSession.statusCode).toBe(302);
    expect(noSession.headers.location).toContain("returnTo=");
    const { cookie } = await login();
    const page = await app.inject({ url: "/device?code=" + pairing.userCode, headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('value="' + pairing.userCode + '"');
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(new DeviceRepository(db).listDevices()).toHaveLength(0);
    const unconsented = await app.inject({ method: "POST", url: "/dashboard/pairings/approve",
      headers: { cookie }, payload: { userCode: pairing.userCode } });
    expect(unconsented.statusCode).toBe(403);
    const result = await app.inject({ method: "POST", url: "/dashboard/pairings/approve",
      headers: { cookie }, payload: { csrf: csrfFrom(page.body), userCode: pairing.userCode.toLowerCase().replace("-", ""), friendlyName: "My Laptop" } });
    expect(result.statusCode).toBe(303);
    const device = new DeviceRepository(db).listDevices()[0]!;
    expect(result.headers.location).toBe("/dashboard/devices/" + device.id);
    const status = await app.inject({ url: "/dashboard/devices/" + device.id + "/status", headers: { cookie } });
    expect(status.json()).toEqual({ deviceId: device.id, state: "OFFLINE" });
    const detail = await app.inject({ url: "/dashboard/devices/" + device.id, headers: { cookie } });
    expect(detail.body).toContain('data-device-id="' + device.id + '"');
    expect((await app.inject({ url: "/dashboard/devices/" + device.id + "/status" })).statusCode).toBe(302);
    expect((await app.inject({ url: "/dashboard/devices/00000000-0000-4000-8000-000000000000/status", headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/dashboard/pairings/approve", headers: { cookie },
      payload: { csrf: csrfFrom(page.body), userCode: pairing.userCode } })).statusCode).toBe(409);
  });

  it("rejects expired and malformed pairing codes without issuing device credentials", async () => {
    const { app, db, login } = await fixture();
    const { cookie } = await login();
    const pairing = (await app.inject({ method: "POST", url: "/api/device-pairings" })).json();
    const page = await app.inject({ url: "/device", headers: { cookie } });
    const csrf = csrfFrom(page.body);
    expect((await app.inject({ method: "POST", url: "/dashboard/pairings/approve",
      headers: { cookie }, payload: { csrf, userCode: "BAD" } })).statusCode).toBe(400);
    db.prepare("UPDATE device_pairings SET expires_at = ? WHERE user_code = ?").run(Date.now() - 1, pairing.userCode);
    expect((await app.inject({ method: "POST", url: "/dashboard/pairings/approve",
      headers: { cookie }, payload: { csrf, userCode: pairing.userCode } })).statusCode).toBe(410);
    expect(new DeviceRepository(db).listDevices()).toHaveLength(0);
  });
});
