import Fastify from "fastify";
import {describe, expect, it} from "vitest";
import {createDatabase} from "../db/database.js";
import {DeviceRepository} from "../devices/device-repository.js";
import {DeviceManagementService} from "../devices/device-management-service.js";
import {ConnectionRegistry} from "../relay/connection-registry.js";
import {RequestBroker} from "../relay/request-broker.js";
import {registerSupportRoutes} from "./routes.js";
import {SupportService} from "./support-service.js";

function fixture(enabled = true) {
  let now = 1_000_000;
  const db = createDatabase(":memory:");
  db.prepare("INSERT INTO owner (id,password_hash,created_at) VALUES ('owner','fixture',0)").run();
  const devices = new DeviceRepository(db);
  const registry = new ConnectionRegistry();
  const service = new SupportService(db, devices,
    new DeviceManagementService(devices, registry, new RequestBroker(registry)), () => now);
  const app = Fastify({logger:false});
  registerSupportRoutes(app, service, {databasePath:":memory:", environment:"test",
    publicBaseUrl:new URL("https://remote.example.com"), supportEnabled:enabled,
    agentInstallEnabled:true, supportAgentVersion:"0.1.6"});
  return {app, db, service, advanceTo(time: number) { now = time; },
    async dispose() { try { await app.close(); } finally { db.close(); } }};
}

const scenarios = [
  {name:"malformed", status:404, code:"SUPPORT_NOT_FOUND", reason:"invalid"},
  {name:"missing", status:404, code:"SUPPORT_NOT_FOUND", reason:"invalid"},
  {name:"ended", status:404, code:"SUPPORT_NOT_FOUND", reason:"invalid"},
  {name:"used", status:409, code:"INVITE_ALREADY_USED", reason:"used"},
  {name:"used after expiry", status:409, code:"INVITE_ALREADY_USED", reason:"used"},
  {name:"expired", status:410, code:"INVITE_EXPIRED", reason:"expired"},
] as const;
type Scenario = typeof scenarios[number]["name"];

function invitationFor(f: ReturnType<typeof fixture>, scenario: Scenario): string {
  if (scenario === "malformed") return "invalid";
  if (scenario === "missing") return "x".repeat(32);
  const {invite, session} = f.service.create("owner", "Private session label");
  if (scenario === "used" || scenario === "used after expiry" || scenario === "ended") {
    f.service.join(invite, "Fixture customer", "win32");
  }
  if (scenario === "ended") f.service.endOwned(session.id, "owner");
  if (scenario === "expired" || scenario === "used after expiry" || scenario === "ended") {
    f.advanceTo(session.inviteExpiresAt);
  }
  return invite;
}

const copy = {
  en: {
    invalid: {title:"Invitation invalid or unavailable",
      reason:"This link cannot be used to join remote support.",
      next:"Check the link with the person providing support. If you still need help, ask for a new invitation."},
    used: {title:"Invitation already used",
      reason:"This link cannot be used to join again.",
      next:"Contact the person providing support to confirm the next step. Ask for a new invitation if you need another support session."},
    expired: {title:"Invitation expired",
      reason:"This link can no longer be used to join remote support.",
      next:"Contact the person who sent you this link and ask for a new invitation."},
  },
  "zh-CN": {
    invalid: {title:"邀请无效或已不可用",
      reason:"此链接无法用于加入远程协助。",
      next:"请向协助人员确认链接；如需继续，请获取新的邀请。"},
    used: {title:"邀请已被使用",
      reason:"此链接无法再次用于加入。",
      next:"请联系协助人员确认下一步；如需新的协助，请获取新的邀请。"},
    expired: {title:"邀请已过期",
      reason:"此链接已无法用于加入远程协助。",
      next:"请联系向你发送链接的协助人员，获取新的邀请。"},
  },
} as const;

const csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const downloads = ["windows.cmd", "macos.command", "linux.sh"] as const;

describe.each(["en", "zh-CN"] as const)("public invitation result pages in %s", (locale) => {
  it.each(scenarios)("renders $name as localized HTML with status $status", async (scenario) => {
    const f = fixture();
    try {
      const invite = invitationFor(f, scenario.name);
      const response = await f.app.inject({url:`/support/invite/${invite}`,
        headers:{"accept-language":locale}});
      const expected = copy[locale][scenario.reason];
      expect(response.statusCode).toBe(scenario.status);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toBe(csp);
      expect(response.body).toContain(`<html lang="${locale}">`);
      expect(response.body).toContain(`<h1 class="h1">${expected.title}</h1>`);
      expect(response.body).toContain(expected.reason);
      expect(response.body).toContain(expected.next);
      expect(response.body).not.toContain("Private session label");
      expect(response.body).not.toContain(scenario.code);
      expect(response.body).not.toContain('href="/dashboard/support');
      expect(response.body).not.toContain("<form");
    } finally { await f.dispose(); }
  });
});

describe("invitation result response boundaries", () => {
  it("uses the locale cookie before Accept-Language and defaults to English", async () => {
    const f = fixture();
    try {
      const selected = await f.app.inject({url:"/support/invite/invalid",
        headers:{cookie:"odr_lang=zh-CN", "accept-language":"en-US"}});
      expect(selected.body).toContain('<html lang="zh-CN">');
      expect(selected.body).toContain(copy["zh-CN"].invalid.title);
      const fallback = await f.app.inject({url:"/support/invite/invalid",
        headers:{cookie:"odr_lang=unsupported", "accept-language":"de"}});
      expect(fallback.body).toContain('<html lang="en">');
      expect(fallback.body).toContain(copy.en.invalid.title);
    } finally { await f.dispose(); }
  });

  it.each(scenarios)("keeps $name errors as JSON for API preview, join and all downloads", async (scenario) => {
    const f = fixture();
    try {
      const invite = invitationFor(f, scenario.name);
      const preview = await f.app.inject({url:`/api/support/invite/${invite}`});
      const join = await f.app.inject({method:"POST", url:"/api/support/join",
        payload:{invite, deviceName:"Another customer", platform:"win32"}});
      const responses = [preview, join];
      for (const suffix of downloads) {
        const download = await f.app.inject({url:`/support/invite/${invite}/${suffix}`});
        expect(download.headers["referrer-policy"]).toBe("no-referrer");
        expect(download.headers["x-content-type-options"]).toBe("nosniff");
        expect(download.headers["content-disposition"]).toBeUndefined();
        responses.push(download);
      }
      expect(preview.headers["referrer-policy"]).toBe("no-referrer");
      for (const response of responses) {
        expect(response.statusCode).toBe(scenario.status);
        expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({error:scenario.code});
      }
    } finally { await f.dispose(); }
  });

  it("keeps status and stop errors as JSON", async () => {
    const f = fixture();
    try {
      for (const action of ["status", "stop"]) {
        const response = await f.app.inject({method:"POST", url:`/api/support/${action}`,
          payload:{refreshCredential:"invalid"}});
        expect(response.statusCode).toBe(404);
        expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual({error:"SUPPORT_NOT_FOUND"});
      }
    } finally { await f.dispose(); }
  });

  it("preserves the empty disabled response without rendering a result page", async () => {
    const f = fixture(false);
    try {
      const page = await f.app.inject({url:"/support/invite/invalid"});
      const preview = await f.app.inject({url:"/api/support/invite/invalid"});
      const join = await f.app.inject({method:"POST", url:"/api/support/join",
        payload:{invite:"invalid", deviceName:"Fixture", platform:"win32"}});
      for (const response of [page, preview, join]) {
        expect(response.statusCode).toBe(404);
        expect(response.body).toBe("");
        expect(response.headers["content-type"]).toBeUndefined();
        expect(response.headers["cache-control"]).toBeUndefined();
      }
      for (const suffix of downloads) {
        const response = await f.app.inject({url:`/support/invite/invalid/${suffix}`});
        expect(response.statusCode).toBe(404);
        expect(response.body).toBe("");
        expect(response.headers["content-type"]).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      }
    } finally { await f.dispose(); }
  });

  it("passes unknown preview failures to the existing error handler", async () => {
    const f = fixture();
    try {
      f.app.setErrorHandler((_error, _request, reply) => {
        return reply.code(503).send({error:"FIXTURE_BACKEND_UNAVAILABLE"});
      });
      f.db.exec("DROP TABLE support_sessions");
      const response = await f.app.inject({url:`/support/invite/${"x".repeat(32)}`});
      expect(response.statusCode).toBe(503);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.json()).toEqual({error:"FIXTURE_BACKEND_UNAVAILABLE"});
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toBe(csp);
    } finally { await f.dispose(); }
  });

  it("does not redeem a valid invitation during HTML preview or any download", async () => {
    const f = fixture();
    try {
      const {invite, session} = f.service.create("owner", "Preview fixture");
      const before = f.db.prepare("SELECT * FROM support_sessions WHERE id=?").get(session.id);
      const page = await f.app.inject({url:`/support/invite/${invite}`});
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
      for (const suffix of downloads) {
        const response = await f.app.inject({url:`/support/invite/${invite}/${suffix}`});
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toBe("application/octet-stream");
      }
      expect(f.db.prepare("SELECT * FROM support_sessions WHERE id=?").get(session.id)).toEqual(before);
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({count:0});
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM device_credentials").get()).toEqual({count:0});
      const joined = await f.app.inject({method:"POST", url:"/api/support/join",
        payload:{invite, deviceName:"Fixture customer", platform:"win32"}});
      expect(joined.statusCode).toBe(201);
    } finally { await f.dispose(); }
  });
});
