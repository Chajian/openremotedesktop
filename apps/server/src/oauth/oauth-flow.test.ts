import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { createOAuthService } from "./authorization-server.js";
import { InvalidAccessTokenError } from "./token-repository.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odr-oauth-flow-"));
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
  return { app, db, config };
}

async function bootstrapAndRegister(
  app: ReturnType<typeof buildApp>,
): Promise<{ clientId: string; cookie: string }> {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/bootstrap",
    payload: { password: "correct-password" },
  });
  expect(bootstrap.statusCode).toBe(201);

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
  expect(registration.statusCode).toBe(201);

  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "correct-password" },
  });
  expect(login.statusCode).toBe(204);

  return {
    clientId: registration.json().client_id as string,
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
  };
}

const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
  .slice(0, 64);

function challengeFor(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function authorizeUrl(
  clientId: string,
  overrides: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.example/callback",
    scope: "mcp",
    state: "state-123",
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    resource: "https://remote.example.com/mcp",
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }
  return `/oauth/authorize?${params.toString()}`;
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

async function authorize(
  app: ReturnType<typeof buildApp>,
  clientId: string,
  cookie: string,
): Promise<{ code: string; location: URL }> {
  const response = await approveConsent(app, authorizeUrl(clientId), cookie);
  expect(response.statusCode).toBe(302);
  const location = new URL(String(response.headers.location));
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code!, location };
}

async function tokenRequest(
  app: ReturnType<typeof buildApp>,
  body: Record<string, string>,
) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(body).toString(),
  });
}

describe("OAuth Authorization Code + PKCE", () => {
  it("redirects an unauthenticated authorization request to owner login", async () => {
    const { app } = fixture();
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

    const response = await app.inject({
      method: "GET",
      url: authorizeUrl(registration.json().client_id),
    });

    expect(response.statusCode).toBe(302);
    expect(String(response.headers.location)).toMatch(/^\/dashboard\/login\?returnTo=/);
  });

  it("issues an opaque one-time code with state and RFC 9207 iss", async () => {
    const { app, db } = fixture();
    const { clientId, cookie } = await bootstrapAndRegister(app);

    const { code, location } = await authorize(app, clientId, cookie);

    expect(location.origin + location.pathname).toBe(
      "https://client.example/callback",
    );
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(
      "https://remote.example.com/",
    );
    expect(code).not.toContain(".");

    const row = db
      .prepare(
        "SELECT code_hash AS codeHash, resource, scope, consumed_at AS consumedAt FROM oauth_codes",
      )
      .get() as {
      codeHash: string;
      resource: string;
      scope: string;
      consumedAt: number | null;
    };
    expect(row.codeHash).not.toBe(code);
    expect(row.resource).toBe("https://remote.example.com/mcp");
    expect(row.scope).toBe("mcp");
    expect(row.consumedAt).toBeNull();
  });

  it("rejects mismatched redirect URIs and missing/plain PKCE", async () => {
    const { app } = fixture();
    const { clientId, cookie } = await bootstrapAndRegister(app);

    const wrongRedirect = await app.inject({
      method: "GET",
      url: authorizeUrl(clientId, {
        redirect_uri: "https://attacker.example/callback",
      }),
      headers: { cookie },
    });
    const missingPkce = await app.inject({
      method: "GET",
      url: authorizeUrl(clientId, {
        code_challenge: undefined,
        code_challenge_method: undefined,
      }),
      headers: { cookie },
    });
    const plainPkce = await app.inject({
      method: "GET",
      url: authorizeUrl(clientId, {
        code_challenge: verifier,
        code_challenge_method: "plain",
      }),
      headers: { cookie },
    });

    expect(wrongRedirect.statusCode).toBeGreaterThanOrEqual(400);
    expect(wrongRedirect.statusCode).toBeLessThan(500);
    expect(wrongRedirect.headers.location).toBeUndefined();
    expect(missingPkce.statusCode).toBe(400);
    expect(plainPkce.statusCode).toBe(400);
  });

  it("does not consume a valid code when the verifier is wrong", async () => {
    const { app } = fixture();
    const { clientId, cookie } = await bootstrapAndRegister(app);
    const { code } = await authorize(app, clientId, cookie);

    const wrong = await tokenRequest(app, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://client.example/callback",
      code_verifier: "Z".repeat(64),
    });
    expect(wrong.statusCode).toBe(400);

    const correct = await tokenRequest(app, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    });
    expect(correct.statusCode).toBe(200);
  });

  it("issues opaque hash-persisted tokens, binds resource/scope, and rejects code reuse", async () => {
    const { app, db, config } = fixture();
    const { clientId, cookie } = await bootstrapAndRegister(app);
    const { code } = await authorize(app, clientId, cookie);

    const response = await tokenRequest(app, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      scope: string;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("mcp");
    expect(body.access_token).not.toContain(".");
    expect(body.refresh_token).not.toContain(".");

    const hashes = db
      .prepare("SELECT token_hash AS tokenHash FROM oauth_tokens")
      .all() as Array<{ tokenHash: string }>;
    expect(hashes).toHaveLength(2);
    expect(hashes.every((row) => row.tokenHash !== body.access_token)).toBe(true);
    expect(hashes.every((row) => row.tokenHash !== body.refresh_token)).toBe(true);

    const oauth = createOAuthService(db, config);
    await expect(
      oauth.verifyAccessToken(
        body.access_token,
        "https://remote.example.com/mcp",
      ),
    ).resolves.toMatchObject({
      clientId,
      scopes: ["mcp"],
      resource: "https://remote.example.com/mcp",
    });
    await expect(
      oauth.verifyAccessToken(
        body.access_token,
        "https://remote.example.com/other",
      ),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);

    const reused = await tokenRequest(app, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    });
    expect(reused.statusCode).toBe(400);
    await expect(
      oauth.verifyAccessToken(
        body.access_token,
        "https://remote.example.com/mcp",
      ),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("supports offline_access for long-lived ChatGPT refresh connectivity", async () => {
    const { app } = fixture();
    const { clientId, cookie } = await bootstrapAndRegister(app);
    const scopedUrl = authorizeUrl(clientId, {
      scope: "mcp offline_access",
    });
    const authorization = await approveConsent(app, scopedUrl, cookie);
    expect(authorization.statusCode).toBe(302);
    const code = new URL(String(authorization.headers.location)).searchParams.get(
      "code",
    );
    expect(code).toBeTruthy();

    const token = await tokenRequest(app, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: code!,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    });
    expect(token.statusCode).toBe(200);
    expect(token.json()).toMatchObject({
      token_type: "Bearer",
      scope: "mcp offline_access",
    });
    expect(token.json().refresh_token).toBeTypeOf("string");

    const refreshed = await tokenRequest(app, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: token.json().refresh_token,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().scope).toBe("mcp offline_access");
  });

  it("rotates refresh tokens and invalidates the old token pair", async () => {
    const { app, config, db } = fixture();
    const { clientId, cookie } = await bootstrapAndRegister(app);
    const { code } = await authorize(app, clientId, cookie);
    const first = await tokenRequest(app, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();

    const rotated = await tokenRequest(app, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: firstBody.refresh_token,
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedBody = rotated.json();
    expect(rotatedBody.access_token).not.toBe(firstBody.access_token);
    expect(rotatedBody.refresh_token).not.toBe(firstBody.refresh_token);

    const reuseOldRefresh = await tokenRequest(app, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: firstBody.refresh_token,
    });
    expect(reuseOldRefresh.statusCode).toBe(400);

    const oauth = createOAuthService(db, config);
    await expect(
      oauth.verifyAccessToken(
        firstBody.access_token,
        "https://remote.example.com/mcp",
      ),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);
    await expect(
      oauth.verifyAccessToken(
        rotatedBody.access_token,
        "https://remote.example.com/mcp",
      ),
    ).resolves.toMatchObject({ clientId });
  });

  it("allows only consented clients and immediately revokes access and refresh tokens", async () => {
    const { app, config, db } = fixture();
    const { clientId, cookie } = await bootstrapAndRegister(app);
    const before = db.prepare(
      "SELECT authorized_at AS approved FROM oauth_clients WHERE client_id = ?",
    ).get(clientId) as { approved: number | null };
    expect(before.approved).toBeNull();

    const url = authorizeUrl(clientId, { scope: "mcp offline_access" });
    const authorization = await approveConsent(app, url, cookie);
    expect(authorization.statusCode).toBe(302);
    const code = new URL(String(authorization.headers.location)).searchParams.get("code")!;
    const tokenResponse = await tokenRequest(app, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    });
    expect(tokenResponse.statusCode).toBe(200);
    const tokens = tokenResponse.json() as { access_token: string; refresh_token: string };
    const oauth = createOAuthService(db, config);
    await expect(oauth.verifyAccessToken(tokens.access_token, oauth.protectedResource))
      .resolves.toMatchObject({ clientId });

    const dashboard = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    expect(dashboard.body).toContain(clientId);
    const revokeUrl = `/dashboard/clients/${clientId}/revoke`;
    const anonymous = await app.inject({ method: "POST", url: revokeUrl });
    expect(anonymous.statusCode).toBe(302);
    const denied = await app.inject({
      method: "POST", url: revokeUrl, headers: { cookie }, payload: { csrf: "wrong" },
    });
    expect(denied.statusCode).toBe(403);
    await expect(oauth.verifyAccessToken(tokens.access_token, oauth.protectedResource)).resolves.toBeDefined();

    const revoked = await app.inject({
      method: "POST", url: revokeUrl, headers: { cookie },
      payload: { csrf: consentField(dashboard.body, "csrf") },
    });
    expect(revoked.statusCode).toBe(303);
    await expect(oauth.verifyAccessToken(tokens.access_token, oauth.protectedResource))
      .rejects.toBeInstanceOf(InvalidAccessTokenError);
    const mcp = await app.inject({
      method: "POST", url: "/mcp", headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(mcp.statusCode).toBe(401);
    const refresh = await tokenRequest(app, {
      grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token,
    });
    expect(refresh.statusCode).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE revoked_at IS NULL").get())
      .toEqual({ n: 0 });

    // Re-approving the connection must not resurrect an old revoked token.
    const reapproved = await approveConsent(app, url, cookie);
    const newCode = new URL(String(reapproved.headers.location)).searchParams.get("code")!;
    const renewed = await tokenRequest(app, {
      grant_type: "authorization_code", client_id: clientId, code: newCode,
      redirect_uri: "https://client.example/callback", code_verifier: verifier,
    });
    expect(renewed.statusCode).toBe(200);
    await expect(oauth.verifyAccessToken(renewed.json().access_token, oauth.protectedResource))
      .resolves.toMatchObject({ clientId });
    await expect(oauth.verifyAccessToken(tokens.access_token, oauth.protectedResource))
      .rejects.toBeInstanceOf(InvalidAccessTokenError);
    const oldRefresh = await tokenRequest(app, {
      grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token,
    });
    expect(oldRefresh.statusCode).toBe(400);
  });
});
