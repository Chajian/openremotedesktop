import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { OwnerRepository } from "./owner-repository.js";
import { DeviceRepository } from "../devices/device-repository.js";

const apps: Array<{ app: ReturnType<typeof buildApp>; db: ReturnType<typeof createDatabase> }> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const { app, db } of apps.splice(0)) { await app.close(); db.close(); }
});

function fixture() {
  const db = createDatabase(":memory:");
  const app = buildApp({db, config: {
    databasePath: ":memory:",
    publicBaseUrl: new URL("https://remote.example.com"),
    environment: "test",
    githubClientId: "test-github-app-id",
    githubClientSecret: "test-github-app-secret",
  }});
  apps.push({app, db});
  return {app,db};
}

async function githubLogin(app: ReturnType<typeof buildApp>, githubId: number, login: string) {
  const outgoing: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    outgoing.push(String(url));
    if (String(url).endsWith("/login/oauth/access_token")) {
      const body = String(options.body);
      expect(new URLSearchParams(body).get("code_verifier")).toBeTruthy();
      return new Response(JSON.stringify({access_token: "test-provider-token", token_type: "bearer"}), {status: 200});
    }
    if (String(url).endsWith("/user")) {
      expect(new Headers(options.headers).get("authorization")).toBe("Bearer test-provider-token");
      return new Response(JSON.stringify({id: githubId, login}), {status: 200});
    }
    throw new Error("Unexpected provider URL");
  }));
  const start = await app.inject({method: "GET", url: "/auth/github?returnTo=%2Fdashboard"});
  expect(start.statusCode).toBe(302);
  const authorizeUrl = new URL(String(start.headers.location));
  expect(authorizeUrl.hostname).toBe("github.com");
  expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  const state = authorizeUrl.searchParams.get("state")!;
  expect(state.length).toBeGreaterThan(24);
  const nonceCookie = String(start.headers["set-cookie"]).split(";")[0]!;
  const callback = await app.inject({
    method: "GET",
    url: "/auth/github/callback?code=github-code&state=" + encodeURIComponent(state),
    headers: {cookie: nonceCookie},
  });
  expect(callback.statusCode).toBe(303);
  expect(callback.headers.location).toBe("/dashboard");
  expect(outgoing).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user"]);
  const setCookies = callback.headers["set-cookie"];
  const allCookies = Array.isArray(setCookies) ? setCookies.join(";") : String(setCookies);
  const sessionCookie = /odr_session=([^;,\s]+)/.exec(allCookies);
  expect(sessionCookie).toBeTruthy();
  const replay = await app.inject({
    method: "GET",
    url: "/auth/github/callback?code=github-code&state=" + encodeURIComponent(state),
    headers: {cookie: nonceCookie},
  });
  expect(replay.statusCode).toBe(403);
  return "odr_session=" + sessionCookie![1];
}

describe("GitHub login as an independent local identity", () => {
  it("uses one-time PKCE login and does not expose the legacy Owner devices", async () => {
    const {app, db} = fixture();
    const root = await new OwnerRepository(db).bootstrapOwner({password: "legacy-passphrase-for-test"});
    new DeviceRepository(db).create("Legacy private PC", root.id);
    const cookie = await githubLogin(app, 12345, "alice");
    const response = await app.inject({method: "GET", url: "/api/devices", headers: {cookie}});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("rejects callback state not bound to the initiating browser", async () => {
    const {app} = fixture();
    const start = await app.inject({method: "GET",url: "/auth/github"});
    expect(start.statusCode).toBe(302);
    const callback = await app.inject({
      method: "GET", url: "/auth/github/callback?code=x&state=arbitrary-state",
      headers: {cookie: String(start.headers["set-cookie"]).split(";")[0]!},
    });
    expect(callback.statusCode).toBe(403);
  });

  it("does not expose GitHub login when credentials are absent", async () => {
    const db = createDatabase(":memory:");
    const app = buildApp({db, config: {
      databasePath: ":memory:", publicBaseUrl: new URL("https://remote.example.com"), environment: "test",
    }});
    apps.push({app, db});
    expect((await app.inject({method: "GET", url: "/auth/github"})).statusCode).toBe(404);
  });
});
