import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { renderConsentPage } from "./consent-page.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
function field(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  if (value === undefined) throw new Error(`Missing form field ${name}`);
  return value.replaceAll("&quot;", '"').replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
function cookie(value: unknown) { return String(value).split(";")[0]!; }
async function fixture() {
  const db = createDatabase(":memory:");
  const app = buildApp({ db, config: { databasePath: ":memory:",
    publicBaseUrl: new URL("https://odr.example.test"), environment: "production" } });
  cleanup.push(async () => { await app.close(); db.close(); });
  const password = "browser-regression-only-passphrase";
  await app.inject({ method: "POST", url: "/api/bootstrap", payload: { password } });
  const registered = await app.inject({ method: "POST", url: "/oauth/register", payload: {
    redirect_uris: ["https://client.example/callback"], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none",
  } });
  const clientId = registered.json().client_id as string;
  const verifier = "a".repeat(64);
  const authorizationUrl = "/oauth/authorize?" + new URLSearchParams({
    client_id: clientId, redirect_uri: "https://client.example/callback", response_type: "code",
    resource: "https://odr.example.test/mcp", scope: "mcp offline_access", state: "return-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  async function login(returnTo: string) {
    const page = await app.inject({ method: "GET", url: "/dashboard/login?" + new URLSearchParams({ returnTo }) });
    const response = await app.inject({ method: "POST", url: "/dashboard/login", headers: {
      cookie: cookie(page.headers["set-cookie"]), "content-type": "application/x-www-form-urlencoded",
    }, payload: new URLSearchParams({ password, returnTo: field(page.body, "returnTo"), csrf: field(page.body, "csrf") }).toString() });
    return { response, session: cookie(response.headers["set-cookie"]) };
  }
  return { app, db, password, clientId, verifier, authorizationUrl, login };
}

describe("browser OAuth login and explicit consent", () => {
  it("follows a real login page, preserves the authorization request, and exchanges a PKCE code", async () => {
    const f = await fixture();
    const start = await f.app.inject({ method: "GET", url: f.authorizationUrl });
    expect(start.statusCode).toBe(302);
    const loginUrl = new URL(String(start.headers.location), "https://odr.example.test");
    expect(loginUrl.pathname).toBe("/dashboard/login");
    expect(loginUrl.searchParams.get("returnTo")).toBe(f.authorizationUrl);
    const page = await f.app.inject({ method: "GET", url: loginUrl.pathname + loginUrl.search });
    expect(page.statusCode).toBe(200);
    const { response, session } = await f.login(f.authorizationUrl);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(f.authorizationUrl);
    expect(String(response.headers["set-cookie"])).toContain("Secure");
    const consent = await f.app.inject({ method: "GET", url: f.authorizationUrl, headers: { cookie: session } });
    expect(consent.statusCode).toBe(200);
    expect(consent.headers.location).toBeUndefined();
    expect(consent.headers["content-security-policy"]).toContain("form-action 'self' https://client.example");
    expect(consent.body).toContain("client.example");
    expect(consent.body).toContain("offline_access");
    expect(consent.body).toContain('name="decision" value="approve"');
    expect(consent.body).toContain('name="decision" value="deny"');
    expect(consent.body).toContain("https://client.example/callback");
    expect(consent.body).not.toMatch(/<(?:script|link|img)\b/i);
    expect(consent.body).toContain('data-view="consent"');
    expect(consent.body).toContain("client.example wants to access your computers");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
    const approved = await f.app.inject({ method: "POST", url: "/oauth/authorize", headers: {
      cookie: session, "content-type": "application/x-www-form-urlencoded",
    }, payload: new URLSearchParams({ csrf: field(consent.body, "csrf"),
      returnTo: field(consent.body, "returnTo"), decision: "approve" }).toString() });
    expect(approved.statusCode).toBe(302);
    const callback = new URL(String(approved.headers.location));
    expect(callback.origin).toBe("https://client.example");
    expect(callback.searchParams.get("state")).toBe("return-state");
    const token = await f.app.inject({ method: "POST", url: "/oauth/token", headers: {
      "content-type": "application/x-www-form-urlencoded",
    }, payload: new URLSearchParams({ grant_type: "authorization_code", client_id: f.clientId,
      redirect_uri: "https://client.example/callback", code: callback.searchParams.get("code")!,
      code_verifier: f.verifier }).toString() });
    expect(token.statusCode).toBe(200);
    expect(token.json().refresh_token).toBeTypeOf("string");
  });

  it("requires login CSRF and refuses external or malformed login return targets", async () => {
    const f = await fixture();
    const noCsrf = await f.app.inject({ method: "POST", url: "/dashboard/login", payload: { password: f.password } });
    expect(noCsrf.statusCode).toBe(403);
    for (const target of ["https://evil.example", "//evil.example", "/\\evil.example", "/%2f%2fevil.example", "/dashboard\r\nLocation:evil"]) {
      const { response } = await f.login(target);
      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe("/dashboard");
    }
  });

  it("binds consent to both the session and the exact authorization request", async () => {
    const f = await fixture();
    const { session } = await f.login(f.authorizationUrl);
    const page = await f.app.inject({ method: "GET", url: f.authorizationUrl, headers: { cookie: session } });
    expect(page.statusCode).toBe(200);
    const missing = await f.app.inject({ method: "POST", url: "/oauth/authorize", headers: { cookie: session },
      payload: { returnTo: f.authorizationUrl, decision: "approve" } });
    expect(missing.statusCode).toBe(403);
    const tampered = await f.app.inject({ method: "POST", url: "/oauth/authorize", headers: { cookie: session },
      payload: { returnTo: f.authorizationUrl + "&state=changed", csrf: field(page.body, "csrf"), decision: "approve" } });
    expect(tampered.statusCode).toBe(403);
    const other = await f.login(f.authorizationUrl);
    const wrongSession = await f.app.inject({ method: "POST", url: "/oauth/authorize", headers: { cookie: other.session },
      payload: { returnTo: f.authorizationUrl, csrf: field(page.body, "csrf"), decision: "approve" } });
    expect(wrongSession.statusCode).toBe(403);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
  });

  it("lets the owner deny without issuing a code", async () => {
    const f = await fixture();
    const { session } = await f.login(f.authorizationUrl);
    const page = await f.app.inject({ method: "GET", url: f.authorizationUrl, headers: { cookie: session } });
    const denied = await f.app.inject({ method: "POST", url: "/oauth/authorize", headers: { cookie: session },
      payload: { returnTo: f.authorizationUrl, csrf: field(page.body, "csrf"), decision: "deny" } });
    expect(denied.statusCode).toBe(302);
    const callback = new URL(String(denied.headers.location));
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("return-state");
    expect(callback.searchParams.get("code")).toBeNull();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
  });
});


describe("Bridge consent presentation", () => {
  const input = { returnTo: "/oauth/authorize?client_id=fixture&scope=mcp", csrf: 'a"b', clientId: '<client>&id', redirectUri: "https://client.example/callback?x=1&y=2", scope: "mcp offline_access" };
  it("uses the bilingual Bridge layout and always shows complete client details", () => {
    const page = renderConsentPage(input);
    expect(page).toContain('class="solo-card"'); expect(page).toContain('class="mini-bridge"');
    expect(page).toContain('client.example 请求访问你的电脑');
    expect(page).toContain('client.example wants to access your computers');
    expect(page).toContain('https://client.example/callback?x=1&amp;y=2');
    expect(page).toContain('&lt;client&gt;&amp;id'); expect(page).not.toContain('<client>');
    expect(page).toContain('mcp offline_access');
    expect(page).toContain('data-capability="files"'); expect(page).toContain('data-capability="terminal"'); expect(page).toContain('data-capability="devices"');
    expect(page).not.toMatch(/<(?:script|link|img)\b/i); expect(page).not.toContain('/dashboard/lang');
  });
  it("describes long-lived access only for the exact offline_access scope token", () => {
    expect(renderConsentPage(input)).toContain('data-capability="offline_access"');
    for (const scope of ["mcp", "mcp offline_access_extra"]) expect(renderConsentPage({ ...input, scope })).not.toContain('data-capability="offline_access"');
  });
  it("preserves escaped hidden field values and explicit approve/deny controls", () => {
    const page = renderConsentPage(input);
    expect(field(page, "csrf")).toBe(input.csrf); expect(field(page, "returnTo")).toBe(input.returnTo);
    expect(page).toContain('<input type="hidden" name="csrf" value="a&quot;b">');
    expect(page).toContain('method="post" action="/oauth/authorize"');
    expect(page).toContain('name="decision" value="approve"'); expect(page).toContain('name="decision" value="deny"');
    expect(page.indexOf('name="decision" value="deny"')).toBeLessThan(page.indexOf('name="decision" value="approve"'));
  });
});
