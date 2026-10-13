import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odr-mcp-auth-"));
  const databasePath = join(dir, "server.sqlite");
  const db = createDatabase(databasePath);
  const config = {
    databasePath,
    publicBaseUrl: new URL("https://remote.example.com"),
    environment: "test" as const,
  };
  const app = buildApp({ db, config });
  cleanups.push(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, db };
}

const verifier =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".slice(
    0,
    64,
  );

function challengeFor(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function consentField(html: string, name: string): string {
  const raw = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
  if (raw === undefined) throw new Error(`Missing consent field ${name}`);
  return raw.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
async function approveConsent(app: ReturnType<typeof buildApp>, url: string, cookie: string) {
  const page = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(page.statusCode).toBe(200);
  return app.inject({ method: "POST", url: "/oauth/authorize", headers: { cookie }, payload: {
    returnTo: consentField(page.body, "returnTo"), csrf: consentField(page.body, "csrf"), decision: "approve",
  } });
}

async function issueAccessToken(app: ReturnType<typeof buildApp>): Promise<string> {
  await app.inject({
    method: "POST",
    url: "/api/bootstrap",
    payload: { password: "correct-password" },
  });
  const registration = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: {
      redirect_uris: ["https://client.example/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  const clientId = registration.json().client_id as string;
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "correct-password" },
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.example/callback",
    scope: "mcp",
    state: "state",
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    resource: "https://remote.example.com/mcp",
  });
  const auth = await approveConsent(app, `/oauth/authorize?${params.toString()}`, cookie);
  const code = new URL(String(auth.headers.location)).searchParams.get("code")!;

  const token = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  return token.json().access_token as string;
}

function initializePayload() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "odr-test-client", version: "0.0.0" },
    },
  };
}

describe("MCP OAuth resource protection", () => {
  it("challenges unauthenticated MCP requests with protected-resource metadata", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: initializePayload(),
    });

    expect(response.statusCode).toBe(401);
    expect(String(response.headers["www-authenticate"])).toContain("Bearer");
    expect(String(response.headers["www-authenticate"])).toContain(
      'resource_metadata="https://remote.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("serves protected-resource metadata pointing to this authorization server", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      resource: "https://remote.example.com/mcp",
      authorization_servers: ["https://remote.example.com/"],
      scopes_supported: ["mcp"],
    });
  });

  it("rejects a token associated with a registered but unapproved client", async () => {
    const { app, db } = fixture();
    const owner = await app.inject({
      method: "POST", url: "/api/bootstrap", payload: { password: "test-password" },
    });
    const registration = await app.inject({
      method: "POST", url: "/oauth/register", payload: {
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code"], response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    const fakeAccess = "test-unapproved-access-token";
    db.prepare(`
      INSERT INTO oauth_tokens (id, token_type, token_hash, client_id, owner_id,
        resource, scope, expires_at, revoked_at, parent_id, originating_auth_code_hash)
      VALUES ('unapproved', 'access', ?, ?, ?, ?, 'mcp', ?, NULL, NULL, NULL)
    `).run(createHash("sha256").update(fakeAccess).digest("hex"),
      registration.json().client_id, owner.json().ownerId,
      "https://remote.example.com/mcp", Date.now() + 60_000);

    const response = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${fakeAccess}` },
      payload: initializePayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a valid token when its stored resource no longer matches /mcp", async () => {
    const { app, db } = fixture();
    const token = await issueAccessToken(app);
    db.prepare(
      "UPDATE oauth_tokens SET resource = ? WHERE token_type = 'access'",
    ).run("https://remote.example.com/other");

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}` },
      payload: initializePayload(),
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects an otherwise valid token missing the mcp scope", async () => {
    const { app, db } = fixture();
    const token = await issueAccessToken(app);
    db.prepare(
      "UPDATE oauth_tokens SET scope = '' WHERE token_type = 'access'",
    ).run();

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}` },
      payload: initializePayload(),
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(401);
    expect(response.statusCode).toBeLessThanOrEqual(403);
  });

  it("lets a valid scoped token reach MCP initialize", async () => {
    const { app } = fixture();
    const token = await issueAccessToken(app);

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
      payload: initializePayload(),
    });

    expect(response.statusCode).toBe(200);
    const contentType = String(response.headers["content-type"]);
    const payload =
      contentType.includes("text/event-stream")
        ? JSON.parse(
            response.payload
              .split(/\r?\n/)
              .find((line) => line.startsWith("data: "))!
              .slice("data: ".length),
          )
        : response.json();
    expect(payload).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: { name: "open-desktop-remote", version: "0.1.0" },
      },
    });
  });

  it("keeps OAuth discovery compatible with PKCE S256 and DCR", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      registration_endpoint: "https://remote.example.com/oauth/register",
      code_challenge_methods_supported: ["S256"],
    });
  });
});
