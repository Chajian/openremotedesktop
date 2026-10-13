import { randomBytes, randomUUID } from "node:crypto";
import {
  OAuthException,
  type OAuthClient,
  type OAuthScope,
  type OAuthToken,
  type OAuthTokenRepository,
  type OAuthUser,
} from "@jmondi/oauth2-server";
import type BetterSqlite3 from "better-sqlite3";
import type { SqliteOAuthAuthCodeRepository } from "./auth-code-repository.js";
import type {
  LibraryClientRepositoryAdapter,
  OAuthResourceContext,
} from "./model.js";
import {
  hashOpaqueSecret,
  normalizeOpaqueSecretHash,
} from "./model.js";

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type TokenRow = {
  id: string;
  token_type: "access" | "refresh";
  client_id: string;
  owner_id: string;
  resource: string;
  scope: string;
  expires_at: number;
  revoked_at: number | null;
  parent_id: string | null;
  originating_auth_code_hash: string | null;
};

export type AuthInfo = {
  ownerId: string;
  clientId: string;
  scopes: string[];
  resource: string;
};

export class InvalidAccessTokenError extends Error {
  constructor() {
    super("Invalid or unauthorized access token");
    this.name = "InvalidAccessTokenError";
  }
}

function scopeNames(scopes: OAuthScope[]): string[] {
  return scopes.map((scope) => scope.name);
}

export class SqliteOAuthTokenRepository implements OAuthTokenRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly clients: LibraryClientRepositoryAdapter,
    private readonly authCodes: SqliteOAuthAuthCodeRepository,
    private readonly resourceContext: OAuthResourceContext,
  ) {}

  async issueToken(
    client: OAuthClient,
    scopes: OAuthScope[],
    user?: OAuthUser | null,
  ): Promise<OAuthToken> {
    return {
      accessToken: randomBytes(32).toString("base64url"),
      accessTokenExpiresAt: new Date(0),
      refreshToken: null,
      refreshTokenExpiresAt: null,
      client,
      user: user ?? null,
      scopes: [...scopes],
    };
  }

  async persist(accessToken: OAuthToken): Promise<void> {
    if (!accessToken.user) {
      throw new Error("OAuth access tokens require an owner");
    }
    const resource = this.resolveResource(accessToken);
    const originHash = accessToken.originatingAuthCodeId
      ? normalizeOpaqueSecretHash(accessToken.originatingAuthCodeId)
      : null;

    this.db
      .prepare(
        `INSERT INTO oauth_tokens
          (id, token_type, token_hash, client_id, owner_id, resource, scope,
           expires_at, revoked_at, parent_id, originating_auth_code_hash)
         VALUES (?, 'access', ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        randomUUID(),
        hashOpaqueSecret(accessToken.accessToken),
        accessToken.client.id,
        String(accessToken.user.id),
        resource,
        scopeNames(accessToken.scopes).join(" "),
        accessToken.accessTokenExpiresAt.getTime(),
        originHash,
      );
  }

  async issueRefreshToken(
    accessToken: OAuthToken,
    _client: OAuthClient,
  ): Promise<OAuthToken> {
    const accessRow = this.rowForRawToken(accessToken.accessToken, "access");
    if (!accessRow) {
      throw new Error("Cannot issue refresh token before access token persistence");
    }

    const rawRefreshToken = randomBytes(32).toString("base64url");
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    accessToken.refreshToken = rawRefreshToken;
    accessToken.refreshTokenExpiresAt = refreshExpiresAt;

    this.db
      .prepare(
        `INSERT INTO oauth_tokens
          (id, token_type, token_hash, client_id, owner_id, resource, scope,
           expires_at, revoked_at, parent_id, originating_auth_code_hash)
         VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        randomUUID(),
        hashOpaqueSecret(rawRefreshToken),
        accessRow.client_id,
        accessRow.owner_id,
        accessRow.resource,
        accessRow.scope,
        refreshExpiresAt.getTime(),
        accessRow.id,
        accessRow.originating_auth_code_hash,
      );

    return accessToken;
  }

  async revoke(accessToken: OAuthToken): Promise<void> {
    const now = Date.now();
    if (accessToken.refreshToken) {
      const refreshHash = hashOpaqueSecret(accessToken.refreshToken);
      const row = this.rowForHash(refreshHash, "refresh");
      if (row) {
        this.db.transaction(() => {
          this.db
            .prepare(
              "UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
            )
            .run(now, row.id);
          if (row.parent_id) {
            this.db
              .prepare(
                "UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
              )
              .run(now, row.parent_id);
          }
        })();
      }
      return;
    }

    this.db
      .prepare(
        "UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ? AND token_type = 'access'",
      )
      .run(now, hashOpaqueSecret(accessToken.accessToken));
  }

  async revokeDescendantsOf(authCodeId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE oauth_tokens
            SET revoked_at = COALESCE(revoked_at, ?)
          WHERE originating_auth_code_hash = ?`,
      )
      .run(Date.now(), normalizeOpaqueSecretHash(authCodeId));
  }

  async isRefreshTokenRevoked(refreshToken: OAuthToken): Promise<boolean> {
    if (!refreshToken.refreshToken) return true;
    const row = this.rowForRawToken(refreshToken.refreshToken, "refresh");
    return !row || row.revoked_at !== null || row.expires_at <= Date.now();
  }

  async isAccessTokenRevoked(accessToken: OAuthToken): Promise<boolean> {
    const row = this.rowForRawToken(accessToken.accessToken, "access");
    return !row || row.revoked_at !== null || row.expires_at <= Date.now();
  }

  async getByRefreshToken(rawRefreshToken: string): Promise<OAuthToken> {
    const row = this.rowForRawToken(rawRefreshToken, "refresh");
    if (!row) throw OAuthException.invalidGrant("Authorization expired or revoked");
    return this.toOAuthToken(row, rawRefreshToken);
  }

  async getByAccessToken(rawAccessToken: string): Promise<OAuthToken> {
    const row = this.rowForRawToken(rawAccessToken, "access");
    if (!row) throw new Error("Access token not found");
    return this.toOAuthToken(row, undefined, rawAccessToken);
  }

  resourceForRefresh(rawRefreshToken: string): string | null {
    return this.rowForRawToken(rawRefreshToken, "refresh")?.resource ?? null;
  }

  async verifyAccessToken(
    rawAccessToken: string,
    resource: string,
  ): Promise<AuthInfo> {
    const row = this.rowForRawToken(rawAccessToken, "access");
    const scopes = row?.scope.split(" ").filter(Boolean) ?? [];
    if (
      !row ||
      row.revoked_at !== null ||
      row.expires_at <= Date.now() ||
      row.resource !== resource ||
      !scopes.includes("mcp")
    ) {
      throw new InvalidAccessTokenError();
    }

    return {
      ownerId: row.owner_id,
      clientId: row.client_id,
      scopes,
      resource: row.resource,
    };
  }

  private resolveResource(accessToken: OAuthToken): string {
    const contextual = this.resourceContext.current();
    if (contextual) return contextual;

    if (accessToken.originatingAuthCodeId) {
      const fromCode = this.authCodes.resourceForHash(
        normalizeOpaqueSecretHash(accessToken.originatingAuthCodeId),
      );
      if (fromCode) return fromCode;
    }

    throw new Error("Missing OAuth protected resource context");
  }

  private rowForRawToken(
    rawToken: string,
    type: "access" | "refresh",
  ): TokenRow | null {
    return this.rowForHash(hashOpaqueSecret(rawToken), type);
  }

  private rowForHash(
    tokenHash: string,
    type: "access" | "refresh",
  ): TokenRow | null {
    return (
      (this.db
        .prepare(
          `SELECT t.id, t.token_type, t.client_id, t.owner_id, t.resource,
                  t.scope, t.expires_at, t.revoked_at, t.parent_id,
                  t.originating_auth_code_hash
             FROM oauth_tokens t
             JOIN oauth_client_grants g ON g.client_id = t.client_id AND g.owner_id = t.owner_id
            WHERE t.token_hash = ? AND t.token_type = ?
              AND g.revoked_at IS NULL`,
        )
        .get(tokenHash, type) as TokenRow | undefined) ?? null
    );
  }

  private async toOAuthToken(
    row: TokenRow,
    rawRefreshToken?: string,
    rawAccessToken?: string,
  ): Promise<OAuthToken> {
    const client = await this.clients.getByIdentifier(row.client_id);
    const scopes = row.scope
      .split(" ")
      .filter(Boolean)
      .map((name) => ({ name }));
    const token: OAuthToken = {
      accessToken: rawAccessToken ?? row.parent_id ?? row.id,
      accessTokenExpiresAt: new Date(row.expires_at),
      refreshToken: rawRefreshToken ?? null,
      refreshTokenExpiresAt:
        row.token_type === "refresh" ? new Date(row.expires_at) : null,
      client,
      user: { id: row.owner_id },
      scopes,
    };
    if (row.originating_auth_code_hash) {
      token.originatingAuthCodeId = row.originating_auth_code_hash;
    }
    return token;
  }
}
