import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import type { ServerConfig } from "../config.js";
import { DeviceRepository, type Device } from "../devices/device-repository.js";
import { OwnerRepository } from "../auth/owner-repository.js";
import { SessionRepository } from "../auth/session-repository.js";
import { OAuthClientRepository } from "../oauth/client-repository.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(overrides: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "odr-dashboard-"));
  const databasePath = join(dir, "server.sqlite");
  const db = createDatabase(databasePath);
  const app = buildApp({
    db,
    config: {
      databasePath,
      publicBaseUrl: new URL("https://remote.example.com"),
      environment: "test",
      ...overrides,
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
  const ownerId = (db.prepare("SELECT id FROM owner WHERE auth_source = 'local'").get() as { id: string }).id;
  return { app, db, login, ownerId };
}


describe("dual-domain production dashboard", () => {
  it("keeps device polling owner-scoped on both domains and reports revoked status", async () => {
    const { app, db, login, ownerId } = await fixture({ additionalPublicBaseUrls: [new URL("https://new.example.com")] });
    const { cookie } = await login();
    const devices = new DeviceRepository(db);
    const own = devices.create("Owned", ownerId);
    const other = new OwnerRepository(db).findOrCreateGitHubUser("808", "other");
    const foreign = devices.create("Private", other.id);
    for (const host of ["remote.example.com", "new.example.com"]) {
      const status = await app.inject({ url: `/dashboard/devices/${own.id}/status`, headers: { host, cookie } });
      expect(status.json()).toEqual({ deviceId: own.id, state: "OFFLINE" });
      expect(status.headers["cache-control"]).toContain("no-store");
      const denied = await app.inject({ url: `/dashboard/devices/${foreign.id}/status`, headers: { host, cookie } });
      expect(denied.statusCode).toBe(404);
      expect(denied.body).not.toContain(foreign.id);
      const detail = await app.inject({ url: `/dashboard/devices/${own.id}`, headers: { host, cookie } });
      expect(detail.body).toContain("data-live-status");
      expect(detail.body).toContain('/dashboard/assets/ui.js');
      expect(detail.body).not.toContain('/dashboard/onboarding.js');
      expect(detail.body).toContain('Open install wizard');
      expect(detail.body).toContain('For source checkout installations only');
    }
    devices.revokeOwnedDevice(own.id, ownerId);
    expect((await app.inject({ url: `/dashboard/devices/${own.id}/status`, headers: { cookie } })).json().state).toBe("REVOKED");
  });
  it.each([
    ["remote.example.com", "https://remote.example.com"],
    ["new.example.com", "https://new.example.com"],
    ["untrusted.example.com", "https://remote.example.com"],
  ])("uses configured Host %s for MCP links and installation commands", async (host, origin) => {
    const { app, login } = await fixture({ additionalPublicBaseUrls: [new URL("https://new.example.com")], agentInstallEnabled: true });
    const { cookie } = await login();
    const headers = { cookie, host, "x-forwarded-host": "spoof.example.com" };
    const mcp = await app.inject({ method: "GET", url: "/dashboard/mcp", headers });
    expect(mcp.statusCode).toBe(200);
    expect(mcp.body).toContain(`${origin}/mcp`);
    expect(mcp.body).not.toContain("spoof.example.com");
    const settings = await app.inject({ method: "GET", url: "/dashboard/settings", headers });
    expect(settings.statusCode).toBe(200);
    expect(settings.body).toContain(`${origin}/mcp`);
    const connect = await app.inject({ method: "GET", url: "/dashboard/connect?step=2", headers });
    expect(connect.statusCode).toBe(200);
    expect(connect.body).toContain(`${origin}/install/windows.ps1`);
    expect(connect.body).toContain(`-Server &#39;${origin}&#39;`);
    expect(connect.body).not.toContain("spoof.example.com");
    const mac = await app.inject({ url: "/dashboard/connect?step=2&os=mac", headers });
    expect(mac.body).toContain(`${origin}/install/macos.sh`);
    expect(mac.body).toContain(`--server &#39;${origin}&#39;`);
    const pairing = (await app.inject({ method: "POST", url: "/api/device-pairings", headers })).json();
    expect(pairing.verificationUri).toBe(`${origin}/device`);
    // Exercise the Agent's actual same-origin guard without changing its policy.
    const { verificationLink } = await import(new URL("../../../agent/src/pairing/browser.ts", import.meta.url).href);
    expect(verificationLink(new URL(origin), pairing.verificationUri, pairing.userCode)).toBe(`${origin}/device?code=${pairing.userCode}`);
    expect(() => verificationLink(new URL("https://spoof.example.com"), pairing.verificationUri, pairing.userCode)).toThrow("Untrusted pairing verification URL");
  });
});

describe("Bridge UI routes", () => {
it("sets the language cookie and returns to a safe path", async () => {
  const { app } = await fixture();
  const ok = await app.inject({ method: "GET", url: "/dashboard/lang?to=zh-CN&returnTo=%2Fdashboard%2Fdevices" });
  expect(ok.statusCode).toBe(303);
  expect(ok.headers.location).toBe("/dashboard/devices");
  expect(String(ok.headers["set-cookie"])).toContain("odr_lang=zh-CN");
  const evil = await app.inject({ method: "GET", url: "/dashboard/lang?to=xx&returnTo=https%3A%2F%2Fevil.example" });
  expect(evil.headers.location).toBe("/dashboard");
  expect(evil.headers["set-cookie"]).toBeUndefined();
});

});

it("keeps encoded traversal returnTo inside the language route whitelist", async () => {
  const { app } = await fixture();
  const candidate = "/dashboard/%2e%2e/auth/github";
  const response = await app.inject({
    method: "GET",
    url: "/dashboard/lang?to=en&returnTo=" + encodeURIComponent(candidate),
  });
  expect(response.statusCode).toBe(303);
  expect(response.headers.location).toBe("/dashboard");
});

function csrfFrom(page: string): string {
  const value = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
  if (!value) throw new Error("CSRF field missing");
  return value;
}

describe("Bridge login", () => {
  it("renders the English Owner form and preserves hidden inputs and private-page headers", async () => {
    const { app } = await fixture();
    const page = await app.inject({ method: "GET", url: "/dashboard/login?returnTo=%2Fdevice" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Sign in to OpenRemote");
    expect(page.body).toContain('class="mini-bridge"');
    expect(page.body).toMatch(/<input type="hidden" name="csrf" value="[^"]+">/);
    expect(page.body).toContain('<input type="hidden" name="returnTo" value="/device">');
    expect(page.body).toContain('type="password" name="password" required autocomplete="current-password"');
    expect(page.body).not.toContain('/auth/github');
    expect(page.body).not.toContain('<details class="owner"');
    expect(page.body).not.toMatch(/<(?:script|link|img)\b/i);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(String(page.headers["set-cookie"])).toContain("HttpOnly; SameSite=Lax; Max-Age=600");
  });
  it("offers GitHub first and keeps the Owner form inside a collapsed details control", async () => {
    const { app } = await fixture({ githubClientId: "test-id", githubClientSecret: "test-secret" });
    const page = await app.inject({ method: "GET", url: "/dashboard/login?returnTo=%2Fdevice" });
    expect(page.body).toContain('class="btn btn-dark btn-lg btn-block"');
    expect(page.body).toContain('href="/auth/github?returnTo=%2Fdevice"');
    expect(page.body).toMatch(/<details class="owner">[\s\S]*<form[^>]*action="\/dashboard\/login"/);
  });
  it("uses Chinese from Accept-Language but gives the language cookie priority", async () => {
    const { app } = await fixture();
    const zh = await app.inject({ method: "GET", url: "/dashboard/login", headers: { "accept-language": "zh-CN" } });
    expect(zh.body).toContain('<html lang="zh-CN">');
    expect(zh.body).toContain("登录 OpenRemote");
    const en = await app.inject({ method: "GET", url: "/dashboard/login", headers: { "accept-language": "zh-CN", cookie: "odr_lang=en" } });
    expect(en.body).toContain('<html lang="en">');
    expect(en.body).toContain("Sign in to OpenRemote");
  });
  it("keeps wrong-password status 401 and reopens the Owner form with feedback", async () => {
    const { app } = await fixture({ githubClientId: "test-id", githubClientSecret: "test-secret" });
    const page = await app.inject({ method: "GET", url: "/dashboard/login" });
    const cookie = String(page.headers["set-cookie"]).split(";")[0]!;
    const denied = await app.inject({ method: "POST", url: "/dashboard/login", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: csrfFrom(page.body), returnTo: "/device", password: "wrong" }).toString() });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).toContain("Incorrect passphrase");
    expect(denied.body).toContain('<details class="owner" open>');
    expect(denied.body).toContain('name="returnTo" value="/device"');
    expect(denied.headers["set-cookie"]).toBeUndefined();
  });
  it("keeps a missing password at 400 and renders the usable login form again", async () => {
    const { app } = await fixture();
    const page = await app.inject({ method: "GET", url: "/dashboard/login" });
    const cookie = String(page.headers["set-cookie"]).split(";")[0]!;
    const response = await app.inject({ method: "POST", url: "/dashboard/login", headers: { cookie }, payload: { csrf: csrfFrom(page.body) } });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Enter your Owner passphrase");
    expect(response.body).toContain('action="/dashboard/login"');
    expect(response.headers["content-type"]).toContain("text/html");
  });
  it("keeps invalid login CSRF at 403 with a script-free recovery page", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "POST", url: "/dashboard/login", payload: { csrf: "bad", password: "old-test-passphrase-123" } });
    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain('href="/dashboard/login"');
    expect(response.body).toContain('data-error-kind="loginExpired"');
    expect(response.body).not.toMatch(/<(?:script|link|img)\b/i);
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });
  it("renders reusable signed-in error pages with navigation and a recovery action", async () => {
    const { renderErrorPage } = await import("./views/error.js");
    const page = renderErrorPage({ locale: "en", status: 404, kind: "notFound", backHref: "/dashboard/devices", ctx: { locale: "en", account: null, nav: "devices", path: "/dashboard/devices/missing", csrf: "csrf", publicBaseUrl: new URL("https://remote.example.com") } });
    expect(page).toContain('data-error-kind="notFound"');
    expect(page).toContain('class="tabs"');
    expect(page).toContain('href="/dashboard/devices"');
    expect(page).toContain('name="csrf" value="csrf"');
  });
});

const viewCtx = { locale: "en" as const, account: null, nav: "devices" as const, path: "/dashboard/devices", csrf: "test-csrf", publicBaseUrl: new URL("https://remote.example.com") };
const sampleDevice: Device = { id: "00000000-0000-4000-8000-000000000001", name: "<b>Work PC</b>", ownerId: "owner", platform: "win32", agentVersion: "0.1.0", desktopCommanderVersion: "0.2.52", createdAt: 1_000, lastSeenAt: 2_000, revokedAt: null, deletedAt: null };

describe("Bridge device pages", () => {
  it("requires a session for each new device page", async () => {
    const { app } = await fixture();
    for (const url of ["/dashboard/devices", "/dashboard/devices/missing", "/dashboard/devices/missing/revoke"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/dashboard/login");
    }
  });
  it("renders owned metadata and escapes the name on list and detail", async () => {
    const { app, db, login, ownerId } = await fixture(); const { cookie } = await login();
    const devices = new DeviceRepository(db); const device = devices.create("<b>unsafe name</b>", ownerId);
    devices.updateRuntimeMetadata(device.id, { platform: "win32", agentVersion: "0.1.0", desktopCommanderVersion: "0.2.52" });
    for (const url of ["/dashboard/devices", `/dashboard/devices/${device.id}`]) {
      const page = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain(`data-device-id="${device.id}"`);
      expect(page.body).toContain('data-state="OFFLINE"');
      expect(page.body).toContain("&lt;b&gt;unsafe name&lt;/b&gt;");
      expect(page.body).not.toContain("<b>unsafe name</b>");
    }
    const detail = await app.inject({ method: "GET", url: `/dashboard/devices/${device.id}`, headers: { cookie } });
    for (const value of ["win32", "0.1.0", "0.2.52", "OFFLINE", "--server https://remote.example.com"]) expect(detail.body).toContain(value);
  });
  it("isolates detail and revoke confirmation by owner, not merely by session", async () => {
    const { app, db } = await fixture(); const owners = new OwnerRepository(db); const sessions = new SessionRepository(db);
    const alice = owners.findOrCreateGitHubUser("101", "alice"); const bob = owners.findOrCreateGitHubUser("202", "bob");
    const devices = new DeviceRepository(db); const mine = devices.create("OnlyAlice", alice.id); const theirs = devices.create("OnlyBob", bob.id);
    const cookie = "odr_session=" + sessions.createOwnerSession(alice.id);
    expect((await app.inject({ method: "GET", url: `/dashboard/devices/${mine.id}`, headers: { cookie } })).statusCode).toBe(200);
    for (const suffix of ["", "/revoke"]) {
      const page = await app.inject({ method: "GET", url: `/dashboard/devices/${theirs.id}${suffix}`, headers: { cookie } });
      expect(page.statusCode).toBe(404); expect(page.body).not.toContain("OnlyBob"); expect(page.body).toContain('data-error-kind="notFound"');
    }
  });
  it("shows revoked devices only in the revoked filter", async () => {
    const { app, db, login, ownerId } = await fixture(); const { cookie } = await login(); const devices = new DeviceRepository(db);
    const active = devices.create("Active", ownerId); const revoked = devices.create("Retired", ownerId); devices.revokeOwnedDevice(revoked.id, ownerId);
    const all = await app.inject({ method: "GET", url: "/dashboard/devices", headers: { cookie } });
    expect(all.body).toContain(`data-device-id="${active.id}"`); expect(all.body).not.toContain(`data-device-id="${revoked.id}"`);
    const old = await app.inject({ method: "GET", url: "/dashboard/devices?status=revoked", headers: { cookie } });
    expect(old.body).toContain(`data-device-id="${revoked.id}"`); expect(old.body).toContain('data-state="REVOKED"'); expect(old.body).not.toContain(`data-device-id="${active.id}"`);
    const online = await app.inject({ method: "GET", url: "/dashboard/devices?status=online", headers: { cookie } });
    expect(online.body).not.toContain(`data-device-id="${active.id}"`);
  });
  it("confirms revocation before posting to the existing endpoint", async () => {
    const { app, db, login, ownerId } = await fixture(); const { cookie } = await login(); const devices = new DeviceRepository(db); const device = devices.create("Work PC", ownerId);
    const page = await app.inject({ method: "GET", url: `/dashboard/devices/${device.id}/revoke`, headers: { cookie } });
    expect(page.statusCode).toBe(200); expect(page.body).toContain(`action="/dashboard/devices/${device.id}/revoke"`); expect(page.body).toContain("No files on the computer will be deleted.");
    expect(devices.findById(device.id)?.revokedAt).toBeNull();
    const response = await app.inject({ method: "POST", url: `/dashboard/devices/${device.id}/revoke`, headers: { cookie }, payload: { csrf: csrfFrom(page.body) } });
    expect(response.statusCode).toBe(303); expect(response.headers.location).toBe(`/dashboard/devices/${device.id}`); expect(devices.findById(device.id)?.revokedAt).not.toBeNull();
  });
  it("shows delete in card and detail, confirms it, and rejects invalid CSRF", async () => {
    const { app, db, login, ownerId } = await fixture();
    const { cookie } = await login();
    const devices = new DeviceRepository(db);
    const device = devices.create("Retired laptop", ownerId);
    const list = await app.inject({method:"GET",url:"/dashboard/devices",headers:{cookie}});
    expect(list.body).toContain(`/dashboard/devices/${device.id}/delete`);
    const detail = await app.inject({method:"GET",url:`/dashboard/devices/${device.id}`,headers:{cookie}});
    expect(detail.body).toContain(`/dashboard/devices/${device.id}/delete`);
    const confirm = await app.inject({method:"GET",url:`/dashboard/devices/${device.id}/delete`,headers:{cookie}});
    expect(confirm.body).toContain("Retired laptop");
    expect(confirm.body).toContain(`action="/dashboard/devices/${device.id}/delete"`);
    const target = `/dashboard/devices/${device.id}/delete`;
    expect((await app.inject({method:"POST",url:target,headers:{cookie},payload:{csrf:"invalid"}})).statusCode).toBe(403);
    expect(devices.findById(device.id)).not.toBeNull();
    const valid = await app.inject({method:"POST",url:target,headers:{cookie},payload:{csrf:csrfFrom(confirm.body)}});
    expect(valid.statusCode).toBe(303);
    expect(valid.headers.location).toBe("/dashboard/devices?deleted=1");
    expect((await app.inject({method:"GET",url:valid.headers.location!,headers:{cookie}})).body).toContain("Device deleted.");
    expect((await app.inject({method:"GET",url:"/dashboard/devices?status=revoked",headers:{cookie}})).body).not.toContain(device.id);
    expect((await app.inject({method:"GET",url:`/dashboard/devices/${device.id}`,headers:{cookie}})).statusCode).toBe(404);
    expect((await app.inject({method:"POST",url:target,headers:{cookie},payload:{csrf:csrfFrom(confirm.body)}})).statusCode).toBe(303);
  });
  it("deletes an already-revoked device and rejects another owner's delete confirmation", async () => {
    const { app, db, login, ownerId } = await fixture();
    const { cookie } = await login();
    const devices = new DeviceRepository(db);
    const retired = devices.create("Old PC",ownerId);
    devices.revokeOwnedDevice(retired.id,ownerId);
    const foreign = new OwnerRepository(db).findOrCreateGitHubUser("9003", "guest");
    const theirs = devices.create("Private PC",foreign.id);
    expect((await app.inject({method:"GET",url:`/dashboard/devices/${theirs.id}/delete`,headers:{cookie}})).statusCode).toBe(404);
    const confirm = await app.inject({method:"GET",url:`/dashboard/devices/${retired.id}/delete`,headers:{cookie}});
    expect(confirm.statusCode).toBe(200);
    const result = await app.inject({method:"POST",url:`/dashboard/devices/${retired.id}/delete`,headers:{cookie},payload:{csrf:csrfFrom(confirm.body)}});
    expect(result.statusCode).toBe(303);
    expect(devices.findById(retired.id)).toBeNull();
    expect(devices.findById(theirs.id)).not.toBeNull();
  });
  it("renames without changing the device ID and renders invalid-name feedback at 400", async () => {
    const { app, db, login, ownerId } = await fixture(); const { cookie } = await login(); const devices = new DeviceRepository(db); const device = devices.create("Old name", ownerId);
    const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } }); const csrf = csrfFrom(page.body);
    const renamed = await app.inject({ method: "POST", url: `/dashboard/devices/${device.id}/rename`, headers: { cookie }, payload: { csrf, name: "New name" } });
    expect(renamed.statusCode).toBe(303); expect(renamed.headers.location).toBe(`/dashboard/devices/${device.id}`); expect(devices.findById(device.id)?.name).toBe("New name");
    const invalid = await app.inject({ method: "POST", url: `/dashboard/devices/${device.id}/rename`, headers: { cookie }, payload: { csrf, name: " " } });
    expect(invalid.statusCode).toBe(400); expect(invalid.headers["content-type"]).toContain("text/html"); expect(invalid.body).toContain('data-rename-error="true"'); expect(devices.findById(device.id)?.name).toBe("New name");
  });
  it("keeps valid mutations of unknown devices at 404 with an HTML recovery page", async () => {
    const { app, login } = await fixture(); const { cookie } = await login(); const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    for (const operation of ["rename", "revoke"]) {
      const response = await app.inject({ method: "POST", url: `/dashboard/devices/missing/${operation}`, headers: { cookie }, payload: { csrf: csrfFrom(page.body), name: "New name" } });
      expect(response.statusCode).toBe(404); expect(response.body).toContain('data-error-kind="notFound"');
    }
  });
  it("retains the existing 400 invalid-name precedence for an unknown ID", async () => {
    const { app, login } = await fixture(); const { cookie } = await login(); const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    const response = await app.inject({ method: "POST", url: "/dashboard/devices/missing/rename", headers: { cookie }, payload: { csrf: csrfFrom(page.body), name: " " } });
    expect(response.statusCode).toBe(400); expect(response.headers["content-type"]).toContain("text/html");
  });
  it.each(["OFFLINE", "EXECUTOR_FAILED", "INCOMPATIBLE"])("provides real recovery commands for %s", async (state) => {
    const { renderDeviceDetail } = await import("./views/device-detail.js");
    const page = renderDeviceDetail(viewCtx, { device: { ...sampleDevice, state }, now: 60_000, renameError: false, paired: false, hasClients: false });
    expect(page).toContain(`data-state="${state}"`); expect(page).toContain("--server https://remote.example.com"); expect(page).toContain("&lt;b&gt;Work PC&lt;/b&gt;"); expect(page).not.toContain("<b>Work PC</b>");
  });
  it("keeps the card copy button outside the device link", async () => {
    const { deviceCard } = await import("./views/devices.js"); const card = deviceCard(viewCtx, { ...sampleDevice, state: "OFFLINE" }, 60_000).value;
    expect(card).toMatch(/^<article\b/); expect(card).toContain(`data-copy="${sampleDevice.id}"`);
    for (const match of card.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)) expect(match[0]).not.toContain("<button");
  });
});

describe("Bridge pairing journey", () => {
  it("requires a session and preserves the Agent device link through Owner login", async () => {
    const { app } = await fixture();
    const wizard = await app.inject({ method: "GET", url: "/dashboard/connect" });
    expect(wizard.statusCode).toBe(302); expect(wizard.headers.location).toBe("/dashboard/login");
    const device = await app.inject({ method: "GET", url: "/device" });
    expect(device.statusCode).toBe(302); expect(device.headers.location).toBe("/dashboard/login?returnTo=%2Fdevice");
    const page = await app.inject({ method: "GET", url: device.headers.location! });
    const response = await app.inject({ method: "POST", url: "/dashboard/login", headers: { cookie: String(page.headers["set-cookie"]).split(";")[0]! }, payload: { csrf: csrfFrom(page.body), returnTo: "/device", password: "old-test-passphrase-123" } });
    expect(response.statusCode).toBe(303); expect(response.headers.location).toBe("/device");
    const back = await app.inject({ method: "GET", url: "/device", headers: { cookie: String(response.headers["set-cookie"]).split(";")[0]! } });
    expect(back.statusCode).toBe(200); expect(back.body).toContain('action="/dashboard/pairings/approve"');
  });
  it("renders all wizard steps with plain navigation and the real instance command", async () => {
    const { app, login } = await fixture(); const { cookie } = await login();
    for (const step of [1, 2, 3]) {
      const page = await app.inject({ method: "GET", url: `/dashboard/connect?step=${step}&os=win`, headers: { cookie } });
      expect(page.statusCode).toBe(200); expect(page.body).toContain(`data-step="${step}"`); expect(page.body).toContain('class="wz"');
      if (step === 2) {
        expect(page.body).toContain("一键安装尚未启用");
        expect(page.body).not.toContain("Installer checksum mismatch");
      }
      if (step === 3) {
        expect(page.body).toContain('action="/dashboard/pairings/approve"');
        expect(page.body).toContain('name="userCode"');
        expect(page.body).toContain('name="friendlyName"');
      }
    }
    const fallback = await app.inject({ method: "GET", url: "/dashboard/connect?step=99&os=bad", headers: { cookie } });
    expect(fallback.body).toContain('data-step="1"'); expect(fallback.body).toContain('data-os="win"');
  });
  it("approves a lowercase unhyphenated code and shows a real fresh waiting state", async () => {
    const { app, login, db } = await fixture(); const { cookie } = await login();
    const pairing = (await app.inject({ method: "POST", url: "/api/device-pairings" })).json();
    const page = await app.inject({ method: "GET", url: "/dashboard/connect?step=3", headers: { cookie } });
    const response = await app.inject({ method: "POST", url: "/dashboard/pairings/approve", headers: { cookie }, payload: { csrf: csrfFrom(page.body), userCode: String(pairing.userCode).replace("-", "").toLowerCase(), friendlyName: "Journey PC" } });
    expect(response.statusCode).toBe(303); expect(response.headers.location).toMatch(/^\/dashboard\/devices\/[0-9a-f-]+$/);
    expect(new DeviceRepository(db).listDevices()[0]?.name).toBe("Journey PC");
    const waiting = await app.inject({ method: "GET", url: response.headers.location!, headers: { cookie } });
    expect(waiting.statusCode).toBe(200); expect(waiting.body).toContain('data-state="OFFLINE"'); expect(waiting.body).toContain("data-live-status"); expect(waiting.headers["content-security-policy"]).toContain("connect-src 'self'");
  });
  it("returns master not-found feedback at 404 without reflecting submitted HTML", async () => {
    const { app, login } = await fixture(); const { cookie } = await login(); const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    const response = await app.inject({ method: "POST", url: "/dashboard/pairings/approve", headers: { cookie }, payload: { csrf: csrfFrom(page.body), userCode: "ZZZZ-ZZZZ", friendlyName: '<b>unsafe</b>' } });
    expect(response.statusCode).toBe(404); expect(response.body).toContain("Pairing code not found"); expect(response.body).not.toContain('<b>unsafe</b>');
  });
  it("returns expired feedback at 410 for an already-expired code", async () => {
    const { app, db, login } = await fixture(); const { cookie } = await login();
    db.prepare("INSERT INTO device_pairings (device_code_hash, user_code, requested_at, expires_at, approved_at, device_id) VALUES (?, ?, ?, ?, NULL, NULL)").run("expired-test-hash", "ABCD-EFGH", Date.now() - 1_200_000, Date.now() - 600_000);
    const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    const response = await app.inject({ method: "POST", url: "/dashboard/pairings/approve", headers: { cookie }, payload: { csrf: csrfFrom(page.body), userCode: "abcdefgh" } });
    expect(response.statusCode).toBe(410); expect(response.body).toContain("Pairing expired"); expect(response.body).toContain("Restart the Agent");
  });
  it("returns reused feedback at 409 without creating a second device", async () => {
    const { app, db, login } = await fixture(); const { cookie } = await login(); const pairing = (await app.inject({ method: "POST", url: "/api/device-pairings" })).json();
    const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } }); const payload = { csrf: csrfFrom(page.body), userCode: pairing.userCode, friendlyName: "One PC" };
    expect((await app.inject({ method: "POST", url: "/dashboard/pairings/approve", headers: { cookie }, payload })).statusCode).toBe(303);
    const reused = await app.inject({ method: "POST", url: "/dashboard/pairings/approve", headers: { cookie }, payload });
    expect(reused.statusCode).toBe(409); expect(reused.body).toContain("Pairing code has already been used"); expect(new DeviceRepository(db).listDevices()).toHaveLength(1);
  });
  it("rejects malformed codes at 400 without reflecting an arbitrary origin", async () => {
    const { app, login } = await fixture(); const { cookie } = await login(); const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    for (const origin of ["device", "connect", "https://evil.example"]) {
      const response = await app.inject({ method: "POST", url: "/dashboard/pairings/approve", headers: { cookie }, payload: { csrf: csrfFrom(page.body), userCode: "bad", friendlyName: "Keep name", origin } });
      expect(response.statusCode).toBe(400); expect(response.body).toContain("Invalid pairing code"); expect(response.body).not.toContain("https://evil.example");
    }
  });
  it.each([["OFFLINE", 1], ["CONNECTED", 2], ["AUTHENTICATED", 3], ["EXECUTOR_STARTING", 4]] as const)("shows observed lifecycle progress for %s", async (state, completed) => {
    const { renderDeviceDetail } = await import("./views/device-detail.js");
    const page = renderDeviceDetail(viewCtx, { device: { ...sampleDevice, state }, now: 60_000, renameError: false, paired: true, hasClients: false });
    expect(page).toContain(`data-completed="${completed}"`); expect(page).toContain('http-equiv="refresh" content="3"'); expect(page).not.toContain('name="name"');
  });
  it("stops waiting refresh after two minutes and offers a manual recovery link", async () => {
    const { renderDeviceDetail } = await import("./views/device-detail.js");
    const page = renderDeviceDetail(viewCtx, { device: { ...sampleDevice, state: "OFFLINE" }, now: 121_000, renameError: false, paired: true, hasClients: false });
    expect(page).not.toContain('http-equiv="refresh"'); expect(page).toContain("Still not online?"); expect(page).toContain(`href="/dashboard/devices/${sampleDevice.id}?paired=1"`);
  });
  it("shows readiness without refresh and points to MCP authorization when needed", async () => {
    const { renderDeviceDetail } = await import("./views/device-detail.js");
    const page = renderDeviceDetail(viewCtx, { device: { ...sampleDevice, state: "READY" }, now: 30_000, renameError: false, paired: true, hasClients: false });
    expect(page).not.toContain('http-equiv="refresh"'); expect(page).toContain('class="success-mark"'); expect(page).toContain('href="/dashboard/mcp"');
  });
  it("does not present a failed or revoked device as still progressing", async () => {
    const { renderDeviceDetail } = await import("./views/device-detail.js");
    for (const state of ["EXECUTOR_FAILED", "INCOMPATIBLE", "REVOKED"]) {
      const page = renderDeviceDetail(viewCtx, { device: { ...sampleDevice, state }, now: 30_000, renameError: false, paired: true, hasClients: false });
      expect(page).toContain(`data-state="${state}"`); expect(page).not.toContain('class="success-mark"'); expect(page).not.toContain('http-equiv="refresh"');
    }
  });
});

describe("Bridge connection and settings", () => {
  it("requires a session for the new settings and client confirmation pages", async () => {
    const { app } = await fixture();
    for (const url of ["/dashboard/settings", "/dashboard/settings/revoke-all", "/dashboard/clients/missing/revoke"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(302); expect(response.headers.location).toBe("/dashboard/login");
    }
  });
  it("shows actual connection information, illustrations and an empty authorization state", async () => {
    const { app, login } = await fixture(); const { cookie } = await login();
    const page = await app.inject({ method: "GET", url: "/dashboard/mcp", headers: { cookie } });
    expect(page.statusCode).toBe(200); expect(page.body).toContain("https://remote.example.com/mcp"); expect(page.body).toContain("OAuth");
    expect(page.body).toContain('data-authorized="false"'); expect(page.body).toContain("Illustration — your ChatGPT screens may differ");
    expect(page.body.match(/class="card gstep"/g)).toHaveLength(4);
    expect(page.body).toContain('id="clients"'); expect(page.body).toContain('action="/dashboard/logout"');
  });
  it("lists only this account’s approved clients and uses an exact-host identity", async () => {
    const { app, db, login, ownerId } = await fixture(); const { cookie } = await login(); const clients = new OAuthClientRepository(db);
    const input = { grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"], tokenEndpointAuthMethod: "none" as const };
    const own = clients.create({ ...input, redirectUris: ["https://chatgpt.com/cb"] }); const spoof = clients.create({ ...input, redirectUris: ["https://chatgpt.com.evil.example/cb"] });
    const bob = new OwnerRepository(db).findOrCreateGitHubUser("606", "bob"); const theirs = clients.create({ ...input, redirectUris: ["https://private-bob.example/cb"] });
    clients.approveClient(own.clientId, ownerId); clients.approveClient(spoof.clientId, ownerId); clients.approveClient(theirs.clientId, bob.id);
    const page = await app.inject({ method: "GET", url: "/dashboard/mcp", headers: { cookie } });
    expect(page.body).toContain('data-authorized="true"'); expect(page.body).toContain(own.clientId); expect(page.body).toContain('chatgpt.com.evil.example'); expect(page.body).not.toContain(theirs.clientId); expect(page.body).not.toContain('private-bob.example');
    const denied = await app.inject({ method: "GET", url: `/dashboard/clients/${theirs.clientId}/revoke`, headers: { cookie } });
    expect(denied.statusCode).toBe(404); expect(denied.body).not.toContain('private-bob.example');
    const confirm = await app.inject({ method: "GET", url: `/dashboard/clients/${own.clientId}/revoke`, headers: { cookie } });
    expect(confirm.statusCode).toBe(200); expect(confirm.body).toContain(`action="/dashboard/clients/${own.clientId}/revoke"`);
    const revoked = await app.inject({ method: "POST", url: `/dashboard/clients/${own.clientId}/revoke`, headers: { cookie }, payload: { csrf: csrfFrom(confirm.body) } });
    expect(revoked.statusCode).toBe(303); expect(revoked.headers.location).toBe("/dashboard/mcp"); expect(clients.listApprovedClients(ownerId).some(c => c.clientId === own.clientId)).toBe(false); expect(clients.listApprovedClients(bob.id)).toHaveLength(1);
  });
  it("shows Owner passphrase controls only for the local Owner", async () => {
    const { app, db, login } = await fixture(); const { cookie } = await login();
    const owner = await app.inject({ method: "GET", url: "/dashboard/settings", headers: { cookie } });
    expect(owner.statusCode).toBe(200); expect(owner.body).toContain('action="/dashboard/password"'); expect(owner.body).toContain('name="newPassword"'); expect(owner.body).toContain('minlength="12"'); expect(owner.body).toContain('data-live-count="0"'); expect(owner.body).not.toContain('href="/dashboard/settings/revoke-all"');
    const user = new OwnerRepository(db).findOrCreateGitHubUser("707", "github-user"); const ghCookie = "odr_session=" + new SessionRepository(db).createOwnerSession(user.id);
    const gh = await app.inject({ method: "GET", url: "/dashboard/settings", headers: { cookie: ghCookie } });
    expect(gh.statusCode).toBe(200); expect(gh.body).toContain("@github-user"); expect(gh.body).not.toContain('action="/dashboard/password"');
    const forbidden = await app.inject({ method: "POST", url: "/dashboard/password", headers: { cookie: ghCookie }, payload: { csrf: csrfFrom(gh.body), currentPassword: "unused", newPassword: "new-password-long-enough" } });
    expect(forbidden.statusCode).toBe(403); expect(forbidden.body).toContain('data-error-kind="forbidden"');
  });
  it("keeps password errors at 400 with usable settings feedback", async () => {
    const { app, login } = await fixture(); const { cookie } = await login(); const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    for (const [newPassword, error] of [["short", "invalid"], ["long-enough-new-passphrase", "incorrect"]]) {
      const response = await app.inject({ method: "POST", url: "/dashboard/password", headers: { cookie }, payload: { csrf: csrfFrom(page.body), currentPassword: "wrong", newPassword } });
      expect(response.statusCode).toBe(400); expect(response.body).toContain(`data-password-error="${error}"`); expect(response.body).toContain('action="/dashboard/password"'); expect(response.body).not.toContain('value="wrong"');
    }
  });
  it("confirms revoke-all without adding a server-side confirmation requirement", async () => {
    const { app, db, ownerId, login } = await fixture(); const { cookie } = await login(); const devices = new DeviceRepository(db); const device = devices.create("All test", ownerId);
    const settings = await app.inject({ method: "GET", url: "/dashboard/settings", headers: { cookie } });
    expect(settings.body).toContain('href="/dashboard/settings/revoke-all"');
    const page = await app.inject({ method: "GET", url: "/dashboard/settings/revoke-all", headers: { cookie } });
    expect(page.statusCode).toBe(200); expect(page.body).toContain('action="/dashboard/devices/revoke-all"'); expect(page.body).toContain('name="confirmText" data-confirm-match="revoke all"');
    const response = await app.inject({ method: "POST", url: "/dashboard/devices/revoke-all", headers: { cookie }, payload: { csrf: csrfFrom(page.body) } });
    expect(response.statusCode).toBe(303); expect(response.headers.location).toBe("/dashboard/devices"); expect(devices.findById(device.id)?.revokedAt).not.toBeNull();
  });
  it("keeps each invalid-CSRF mutation at 403 and links back to its source page", async () => {
    const { app, db, ownerId, login } = await fixture(); const { cookie } = await login(); const devices = new DeviceRepository(db); const device = devices.create("Unchanged", ownerId);
    const cases = [
      ["/dashboard/logout", "/dashboard", ""],
      [`/dashboard/devices/${device.id}/rename`, `/dashboard/devices/${device.id}`, ""],
      [`/dashboard/devices/${device.id}/revoke`, `/dashboard/devices/${device.id}`, ""],
      ["/dashboard/pairings/approve", "/dashboard/connect?step=3", "connect"],
      ["/dashboard/pairings/approve", "/device", "device"],
      ["/dashboard/clients/missing/revoke", "/dashboard/mcp", ""],
      ["/dashboard/devices/revoke-all", "/dashboard/settings", ""],
      ["/dashboard/password", "/dashboard/settings", ""],
    ];
    for (const [url, backHref, origin] of cases) {
      const response = await app.inject({ method: "POST", url: url!, headers: { cookie }, payload: { csrf: "bad", origin, name: "Changed" } });
      expect(response.statusCode).toBe(403); expect(response.headers["content-type"]).toContain("text/html"); expect(response.body).toContain('data-error-kind="expired"'); expect(response.body).toContain(`href="${backHref}"`);
    }
    expect(devices.findById(device.id)?.name).toBe("Unchanged"); expect(devices.findById(device.id)?.revokedAt).toBeNull();
    expect((await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } })).statusCode).toBe(200);
  });
});

describe("Bridge overview", () => {
  it("guides a new account to OS selection or its existing pairing code", async () => {
    const { app, login } = await fixture(); const { cookie } = await login();
    const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    expect(page.statusCode).toBe(200); expect(page.body).toContain('data-view="overview"'); expect(page.body).toContain('data-live-count="0"');
    for (const os of ["win", "mac", "linux"]) expect(page.body).toContain(`href="/dashboard/connect?step=2&amp;os=${os}"`);
    expect(page.body).toContain('href="/device"'); expect(page.body).toContain('href="/dashboard/connect"'); expect(page.body).toContain('action="/dashboard/logout"');
    expect(page.body).not.toContain('action="/dashboard/password"'); expect(page.body).not.toContain('action="/dashboard/pairings/approve"');
    expect(page.body.match(/class="jcard /g)).toHaveLength(3);
  });
  it("shows actual registered devices without claiming they are online or authorized", async () => {
    const { app, db, ownerId, login } = await fixture(); const { cookie } = await login(); const device = new DeviceRepository(db).create("<b>x</b>", ownerId);
    const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    expect(page.body).toContain(`data-device-id="${device.id}"`); expect(page.body).toContain('data-ready-count="0"'); expect(page.body).toContain('data-authorized="false"');
    expect(page.body).toContain('href="/dashboard/mcp"'); expect(page.body).toContain("&lt;b&gt;x&lt;/b&gt;"); expect(page.body).not.toContain("<b>x</b>");
    expect(page.body).not.toContain('class="bline ok"');
  });
  it("treats revoked-only accounts as needing a new computer", async () => {
    const { app, db, ownerId, login } = await fixture(); const { cookie } = await login(); const devices = new DeviceRepository(db); const device = devices.create("Old retired", ownerId); devices.revokeOwnedDevice(device.id, ownerId);
    const page = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    expect(page.body).toContain('data-live-count="0"'); expect(page.body).toContain('class="journey"'); expect(page.body).not.toContain(`data-device-id="${device.id}"`);
  });
  it("uses real readiness, the configured host and the first approved client in the bridge", async () => {
    const { renderOverview } = await import("./views/overview.js");
    const devices = Array.from({ length: 6 }, (_, i) => ({ ...sampleDevice, id: `device-${i}`, name: `Actual ${i}`, state: i === 0 ? "READY" : i === 1 ? "EXECUTOR_FAILED" : "OFFLINE" }));
    const page = renderOverview({ ...viewCtx, publicBaseUrl: new URL("https://self-hosted.example") }, { devices, clients: [{ clientId: "qa-claude", redirectUris: ["https://claude.ai/cb"], authorizedAt: 1000 }], now: 60_000 });
    expect(page).toContain('data-live-count="6"'); expect(page).toContain('data-ready-count="1"'); expect(page).toContain('data-client-host="claude.ai"'); expect(page).toContain('self-hosted.example'); expect(page).not.toContain('www.xiaofenmao.xyz');
    expect(page.match(/data-bridge-device=/g)).toHaveLength(4); expect(page).toContain('class="bridge-note err"'); expect(page).toContain('href="/dashboard/devices/device-1"');
    expect(page).toContain('data-authorized="true"'); expect(page).toContain('Claude');
  });
  it("labels unknown approved hosts without misidentifying them as ChatGPT", async () => {
    const { renderOverview } = await import("./views/overview.js");
    const page = renderOverview(viewCtx, { devices: [{ ...sampleDevice, state: "READY" }], clients: [{ clientId: "qa-other", redirectUris: ["https://chatgpt.com.evil.example/cb"], authorizedAt: 1000 }], now: 60_000 });
    expect(page).toContain('data-client-host="chatgpt.com.evil.example"'); expect(page).toContain('<div class="bnode-title">chatgpt.com.evil.example</div>');
  });
});
