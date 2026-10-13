import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { buildAuthorizationServerMetadata } from "./metadata.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "odr-dcr-"));
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
  return { app, db };
}

const validRegistration = {
  redirect_uris: ["https://chat.example.com/oauth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

describe("OAuth authorization server metadata", () => {
  it("advertises the self-hosted authorization, token and DCR endpoints", () => {
    const metadata = buildAuthorizationServerMetadata(
      new URL("https://remote.example.com"),
    );

    expect(metadata).toMatchObject({
      issuer: "https://remote.example.com/",
      authorization_endpoint: "https://remote.example.com/oauth/authorize",
      token_endpoint: "https://remote.example.com/oauth/token",
      registration_endpoint: "https://remote.example.com/oauth/register",
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp", "offline_access"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("dynamic client registration", () => {
  it("registers a public client and persists exact redirect URIs", async () => {
    const { app, db } = fixture();

    const response = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: validRegistration,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.client_id).toBeTypeOf("string");
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body).not.toHaveProperty("client_secret");

    const row = db
      .prepare(
        "SELECT redirect_uris_json AS redirectUrisJson FROM oauth_clients WHERE client_id = ?",
      )
      .get(body.client_id) as { redirectUrisJson: string };
    expect(JSON.parse(row.redirectUrisJson)).toEqual(validRegistration.redirect_uris);
  });

  it("gives equivalent repeated registrations independent client ids", async () => {
    const { app } = fixture();

    const first = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: validRegistration,
    });
    const second = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: validRegistration,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().client_id).not.toBe(second.json().client_id);
  });

  it("rejects insecure redirect URIs except loopback development callbacks", async () => {
    const { app } = fixture();

    const insecure = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        ...validRegistration,
        redirect_uris: ["http://evil.example/callback"],
      },
    });
    const loopback = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        ...validRegistration,
        redirect_uris: ["http://127.0.0.1:43123/callback"],
      },
    });

    expect(insecure.statusCode).toBe(400);
    expect(loopback.statusCode).toBe(201);
  });

  it("rejects unsupported grants and response types", async () => {
    const { app } = fixture();

    const unsupportedGrant = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        ...validRegistration,
        grant_types: ["client_credentials"],
      },
    });
    const unsupportedResponse = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        ...validRegistration,
        response_types: ["token"],
      },
    });

    expect(unsupportedGrant.statusCode).toBe(400);
    expect(unsupportedResponse.statusCode).toBe(400);
  });

  it("serves discovery metadata over HTTP", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().registration_endpoint).toBe(
      "https://remote.example.com/oauth/register",
    );
  });
});
