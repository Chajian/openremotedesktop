import { randomBytes } from "node:crypto";
import {
  OAuthException,
  type CodeChallengeMethod,
  type OAuthAuthCode,
  type OAuthAuthCodeRepository,
  type OAuthClient,
  type OAuthScope,
  type OAuthUser,
} from "@jmondi/oauth2-server";
import type BetterSqlite3 from "better-sqlite3";
import type {
  LibraryClientRepositoryAdapter,
  OAuthResourceContext,
  OwnerOAuthUserRepository,
} from "./model.js";
import {
  hashOpaqueSecret,
  normalizeOpaqueSecretHash,
} from "./model.js";

type AuthCodeRow = {
  client_id: string;
  owner_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  expires_at: number;
  consumed_at: number | null;
};

export class SqliteOAuthAuthCodeRepository
  implements OAuthAuthCodeRepository
{
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly clients: LibraryClientRepositoryAdapter,
    private readonly users: OwnerOAuthUserRepository,
    private readonly resourceContext: OAuthResourceContext,
  ) {}

  issueAuthCode(
    client: OAuthClient,
    user: OAuthUser | undefined,
    scopes: OAuthScope[],
  ): OAuthAuthCode {
    return {
      code: randomBytes(32).toString("base64url"),
      expiresAt: new Date(0),
      user: user ?? null,
      client,
      scopes: [...scopes],
    };
  }

  async persist(authCode: OAuthAuthCode): Promise<void> {
    const resource = this.resourceContext.current();
    if (!resource) {
      throw OAuthException.internalServerError(
        "Missing resource context for authorization code",
      );
    }
    if (!authCode.user) {
      throw OAuthException.invalidGrant("Authorization code requires an owner");
    }
    if (!authCode.redirectUri || !authCode.codeChallenge) {
      throw OAuthException.invalidGrant(
        "Authorization code is missing redirect URI or PKCE challenge",
      );
    }

    this.db
      .prepare(
        `INSERT INTO oauth_codes
          (code_hash, client_id, owner_id, redirect_uri, code_challenge,
           resource, scope, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        hashOpaqueSecret(authCode.code),
        authCode.client.id,
        String(authCode.user.id),
        authCode.redirectUri,
        authCode.codeChallenge,
        resource,
        authCode.scopes.map((scope) => scope.name).join(" "),
        authCode.expiresAt.getTime(),
      );
  }

  async getByIdentifier(rawCode: string): Promise<OAuthAuthCode> {
    const row = this.findRowByHash(hashOpaqueSecret(rawCode));
    if (!row) throw OAuthException.invalidParameter("code");

    const client = await this.clients.getByIdentifier(row.client_id);
    const user = await this.users.getUserByCredentials(row.owner_id);
    if (!user) throw OAuthException.invalidGrant("Owner no longer exists");

    return {
      code: rawCode,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: "S256" satisfies CodeChallengeMethod,
      expiresAt: new Date(row.expires_at),
      user,
      client,
      scopes: row.scope
        .split(" ")
        .filter(Boolean)
        .map((name) => ({ name })),
    };
  }

  async isRevoked(rawCode: string): Promise<boolean> {
    const row = this.findRowByHash(hashOpaqueSecret(rawCode));
    return !row || row.consumed_at !== null;
  }

  async revoke(rawCode: string): Promise<void> {
    this.db
      .prepare(
        "UPDATE oauth_codes SET consumed_at = COALESCE(consumed_at, ?) WHERE code_hash = ?",
      )
      .run(Date.now(), hashOpaqueSecret(rawCode));
  }

  resourceForCode(rawCode: string): string | null {
    return this.resourceForHash(hashOpaqueSecret(rawCode));
  }

  resourceForHash(codeHash: string): string | null {
    const row = this.db
      .prepare("SELECT resource FROM oauth_codes WHERE code_hash = ?")
      .get(normalizeOpaqueSecretHash(codeHash)) as
      | { resource: string }
      | undefined;
    return row?.resource ?? null;
  }

  private findRowByHash(codeHash: string): AuthCodeRow | null {
    return (
      (this.db
        .prepare(
          `SELECT client_id, owner_id, redirect_uri, code_challenge,
                  resource, scope, expires_at, consumed_at
             FROM oauth_codes WHERE code_hash = ?`,
        )
        .get(codeHash) as AuthCodeRow | undefined) ?? null
    );
  }
}
