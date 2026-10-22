import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildApp } from "../../../apps/server/src/app.js";
import { createDatabase } from "../../../apps/server/src/db/database.js";
import { relayRegistryFor } from "../../../apps/server/src/relay/relay-route.js";

const PKCE_VERIFIER =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".slice(
    0,
    64,
  );

function pkceChallenge(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function expectOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;

export async function startTestServer(
  options: { databasePath?: string; port?: number } = {},
) {
  const dataDir =
    options.databasePath === undefined
      ? mkdtempSync(join(tmpdir(), "odr-e2e-server-"))
      : dirname(options.databasePath);
  const databasePath = options.databasePath ?? join(dataDir, "server.sqlite");
  const port = options.port ?? (await reservePort());
  const baseUrl = new URL(`http://127.0.0.1:${port}/`);
  const db = createDatabase(databasePath);
  const app = buildApp({
    db,
    config: {
      databasePath,
      publicBaseUrl: baseUrl,
      environment: "test",
    },
  });
  let relayApp: ReturnType<typeof buildApp> | undefined;
  // The relay is registered inside an encapsulated Fastify plugin. Capture that
  // instance so tests can wait for negotiation without arbitrary sleeps.
  app.addHook("onRoute", function (route) {
    if (route.url === "/relay") relayApp = this;
  });
  const serverErrors: Error[] = [];
  app.addHook("onError", async (_request, _reply, error) => {
    serverErrors.push(error);
  });
  await app.listen({ host: "127.0.0.1", port });

  async function bootstrapAndLogin(password = "correct-password") {
    const bootstrap = await fetch(new URL("/api/bootstrap", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (![201, 409].includes(bootstrap.status)) {
      throw new Error(
        `Unexpected bootstrap status ${bootstrap.status}: ${await bootstrap.text()}`,
      );
    }

    const login = await expectOk(
      await fetch(new URL("/api/login", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      }),
    );
    const setCookie = login.headers.get("set-cookie");
    if (!setCookie) throw new Error("Owner login did not set a session cookie");
    return setCookie.split(";")[0]!;
  }

  async function issueMcpAccessToken(cookie: string): Promise<string> {
    const redirectUri = new URL("/callback", baseUrl).toString();
    const registration = await expectOk(
      await fetch(new URL("/oauth/register", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    const clientId = (await registration.json() as { client_id: string }).client_id;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "mcp",
      state: "e2e-state",
      code_challenge: pkceChallenge(PKCE_VERIFIER),
      code_challenge_method: "S256",
      resource: new URL("/mcp", baseUrl).toString(),
    });
    const consent = await fetch(
      new URL(`/oauth/authorize?${params.toString()}`, baseUrl),
      {
        method: "GET",
        headers: { cookie },
        redirect: "manual",
      },
    );
    if (consent.status !== 200) throw new Error(`Consent page failed: ${consent.status}`);
    const html = await consent.text();
    const field = (name: string) => {
      const raw = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
      if (raw === undefined) throw new Error(`Missing consent field ${name}`);
      return raw.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    };
    const authorization = await fetch(new URL("/oauth/authorize", baseUrl), {
      method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: field("csrf"), returnTo: field("returnTo"), decision: "approve" }),
    });
    if (authorization.status !== 302) {
      throw new Error(
        `Authorization failed: ${authorization.status} ${await authorization.text()}`,
      );
    }
    const location = authorization.headers.get("location");
    if (!location) throw new Error("Authorization response has no location");
    const code = new URL(location, baseUrl).searchParams.get("code");
    if (!code) throw new Error("Authorization response has no code");

    const token = await expectOk(
      await fetch(new URL("/oauth/token", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: PKCE_VERIFIER,
        }),
      }),
    );
    return (await token.json() as { access_token: string }).access_token;
  }

  async function pairDevice(cookie: string, friendlyName: string) {
    const created = await expectOk(
      await fetch(new URL("/api/device-pairings", baseUrl), {
        method: "POST",
      }),
    );
    const pairing = await created.json() as {
      deviceCode: string;
      userCode: string;
    };
    await expectOk(
      await fetch(
        new URL(
          `/api/device-pairings/${encodeURIComponent(pairing.userCode)}/approve`,
          baseUrl,
        ),
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ friendlyName }),
        },
      ),
    );
    const polled = await expectOk(
      await fetch(
        new URL(
          `/api/device-pairings/poll?device_code=${encodeURIComponent(
            pairing.deviceCode,
          )}`,
          baseUrl,
        ),
      ),
    );
    const body = await polled.json() as {
      status: string;
      deviceId: string;
      refreshCredential: string;
    };
    if (body.status !== "approved") {
      throw new Error(`Expected approved pairing, got ${body.status}`);
    }
    return {
      serverUrl: baseUrl.toString(),
      deviceId: body.deviceId,
      refreshCredential: body.refreshCredential,
    };
  }

  async function close(removeData = options.databasePath === undefined) {
    await app.close();
    db.close();
    if (removeData) rmSync(dataDir, { recursive: true, force: true });
  }

  return {
    app,
    get relayRegistry() {
      if (!relayApp) throw new Error("Test Server relay route was not registered");
      return relayRegistryFor(relayApp);
    },
    db,
    dataDir,
    databasePath,
    port,
    baseUrl,
    serverErrors,
    bootstrapAndLogin,
    issueMcpAccessToken,
    pairDevice,
    close,
  };
}

export async function connectMcpClient(baseUrl: URL, accessToken: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL("/mcp", baseUrl),
    {
      authProvider: {
        token: async () => accessToken,
      },
    },
  );
  const client = new Client({
    name: "open-desktop-remote-e2e",
    version: "0.0.0",
  });
  await client.connect(transport);
  return client;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}
