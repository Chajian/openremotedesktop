import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { OwnerRepository } from "./owner-repository.js";
import type { SessionRepository } from "./session-repository.js";
import type { ServerConfig } from "../config.js";
import { safeReturnTo, privateBrowserPage } from "../dashboard/browser-auth.js";
import { sessionCookie } from "../routes/login.js";

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const TEN_MINUTES = 600_000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function challenge(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function cookieFor(nonce: string, config: ServerConfig): string {
  return "odr_gh_login=" + nonce + "; Path=/auth/github; Max-Age=600; HttpOnly; SameSite=Lax" +
    (config.environment === "production" ? "; Secure" : "");
}

function nonceFrom(cookie: string | undefined): string | null {
  const value = /(?:^|;\s*)odr_gh_login=([A-Za-z0-9_-]{43})(?:;|$)/.exec(cookie ?? "")?.[1];
  return value ?? null;
}

function sameHash(a: string, b: string): boolean {
  const actual = Buffer.from(a, "hex");
  const expected = Buffer.from(b, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function registerGitHubAuthRoutes(
  app: FastifyInstance,
  db: BetterSqlite3.Database,
  owners: OwnerRepository,
  sessions: SessionRepository,
  config: ServerConfig,
): void {
  const clientId = config.githubClientId;
  const clientSecret = config.githubClientSecret;
  const enabled = Boolean(clientId && clientSecret);
  const redirectUri = new URL("/auth/github/callback", config.publicBaseUrl).toString();
  const clearNonce = cookieFor("", config).replace("Max-Age=600", "Max-Age=0");

  app.get("/auth/github", async (request, reply) => {
    privateBrowserPage(reply);
    if (!enabled) return reply.code(404).send("GitHub login is not configured");
    const query = request.query as { returnTo?: unknown };
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const now = Date.now();
    db.prepare("DELETE FROM github_login_attempts WHERE expires_at <= ?").run(now);
    db.prepare(
      "INSERT INTO github_login_attempts (state_hash, nonce_hash, code_verifier, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(hash(state), hash(nonce), verifier, safeReturnTo(query.returnTo), now + TEN_MINUTES, now);
    const url = new URL(GITHUB_AUTH_URL);
    url.searchParams.set("client_id", clientId!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    reply.header("Set-Cookie", cookieFor(nonce, config));
    return reply.code(302).header("Location", url.toString()).send();
  });

  app.get("/auth/github/callback", async (request, reply) => {
    privateBrowserPage(reply);
    reply.header("Set-Cookie", clearNonce);
    if (!enabled) return reply.code(404).send("GitHub login is not configured");
    const query = request.query as Record<string, unknown>;
    const state = query.state;
    const code = query.code;
    const nonce = nonceFrom(request.headers.cookie);
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        typeof code !== "string" || !code || code.length > 4096 || !nonce) {
      return reply.code(403).send("Invalid GitHub login attempt");
    }
    const row = db.transaction(() => {
      const attempt = db.prepare(
        "SELECT nonce_hash AS nonceHash, code_verifier AS verifier, return_to AS returnTo, expires_at AS expiresAt " +
        "FROM github_login_attempts WHERE state_hash = ?"
      ).get(hash(state)) as { nonceHash: string; verifier: string; returnTo: string; expiresAt: number } | undefined;
      if (attempt) db.prepare("DELETE FROM github_login_attempts WHERE state_hash = ?").run(hash(state));
      return attempt;
    })();
    if (!row || row.expiresAt <= Date.now() || !sameHash(row.nonceHash, hash(nonce))) {
      return reply.code(403).send("Invalid GitHub login attempt");
    }

    try {
      const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId!, client_secret: clientSecret!, code,
          redirect_uri: redirectUri, code_verifier: row.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenResponse.ok) return reply.code(502).send("GitHub login unavailable");
      const token = await tokenResponse.json() as {access_token?: unknown};
      if (typeof token?.access_token !== "string" || !token.access_token) {
        return reply.code(502).send("GitHub login unavailable");
      }
      const profileResponse = await fetch(GITHUB_USER_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token.access_token,
          "User-Agent": "open-desktop-remote",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!profileResponse.ok) return reply.code(502).send("GitHub identity unavailable");
      const identity = await profileResponse.json() as {id?: unknown; login?: unknown};
      if (typeof identity.id !== "number" || !Number.isSafeInteger(identity.id) || identity.id <= 0 ||
          typeof identity.login !== "string") {
        return reply.code(502).send("Invalid GitHub identity");
      }
      const account = owners.findOrCreateGitHubUser(String(identity.id), identity.login);
      const session = sessions.createOwnerSession(account.id);
      reply.header("Set-Cookie", [clearNonce, sessionCookie(session, sessions.ttlMs, config)]);
      return reply.code(303).header("Location", safeReturnTo(row.returnTo)).send();
    } catch {
      return reply.code(502).send("GitHub login unavailable");
    }
  });
}
