import { randomBytes } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

export type OAuthClientRegistrationInput = {
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: "none";
};

export type OAuthClient = OAuthClientRegistrationInput & {
  clientId: string;
  createdAt: number;
};

export type AuthorizedOAuthClient = {
  clientId: string;
  redirectUris: string[];
  authorizedAt: number;
};

type OAuthClientRow = {
  client_id: string;
  redirect_uris_json: string;
  grant_types_json: string;
  response_types_json: string;
  token_endpoint_auth_method: "none";
  created_at: number;
};

export class OAuthClientRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(input: OAuthClientRegistrationInput): OAuthClient {
    const client: OAuthClient = {
      clientId: randomBytes(24).toString("base64url"),
      createdAt: Date.now(),
      ...input,
    };

    this.db
      .prepare(
        `INSERT INTO oauth_clients
          (client_id, redirect_uris_json, grant_types_json, response_types_json,
           token_endpoint_auth_method, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client.clientId,
        JSON.stringify(client.redirectUris),
        JSON.stringify(client.grantTypes),
        JSON.stringify(client.responseTypes),
        client.tokenEndpointAuthMethod,
        client.createdAt,
      );

    return client;
  }

  find(clientId: string): OAuthClient | null {
    const row = this.db
      .prepare(
        `SELECT client_id, redirect_uris_json, grant_types_json,
                response_types_json, token_endpoint_auth_method, created_at
           FROM oauth_clients WHERE client_id = ?`,
      )
      .get(clientId) as OAuthClientRow | undefined;

    if (!row) return null;
    return {
      clientId: row.client_id,
      redirectUris: JSON.parse(row.redirect_uris_json) as string[],
      grantTypes: JSON.parse(row.grant_types_json) as string[],
      responseTypes: JSON.parse(row.response_types_json) as string[],
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      createdAt: row.created_at,
    };
  }

  approveClient(clientId: string, ownerId: string): void {
    if (!this.find(clientId)) throw new Error("OAuth client not found");
    this.db.prepare(
      "INSERT INTO oauth_client_grants (client_id, owner_id, authorized_at, revoked_at) VALUES (?, ?, ?, NULL) " +
      "ON CONFLICT(client_id, owner_id) DO UPDATE SET authorized_at = excluded.authorized_at, revoked_at = NULL",
    ).run(clientId, ownerId, Date.now());
  }

  listApprovedClients(ownerId: string): AuthorizedOAuthClient[] {
    const rows = this.db.prepare(
      "SELECT c.client_id, c.redirect_uris_json, g.authorized_at " +
      "FROM oauth_clients c JOIN oauth_client_grants g ON g.client_id = c.client_id " +
      "WHERE g.owner_id = ? AND g.revoked_at IS NULL ORDER BY g.authorized_at DESC",
    ).all(ownerId) as Array<{
      client_id: string;
      redirect_uris_json: string;
      authorized_at: number;
    }>;
    return rows.map((row) => ({
      clientId: row.client_id,
      redirectUris: JSON.parse(row.redirect_uris_json) as string[],
      authorizedAt: row.authorized_at,
    }));
  }

  revokeClient(clientId: string, ownerId: string): boolean {
    return this.db.transaction(() => {
      const now = Date.now();
      const updated = this.db.prepare(
        "UPDATE oauth_client_grants SET revoked_at = ? WHERE client_id = ? AND owner_id = ? AND revoked_at IS NULL",
      ).run(now, clientId, ownerId);
      if (updated.changes !== 1) return false;
      this.db.prepare(
        "UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE client_id = ? AND owner_id = ?",
      ).run(now, clientId, ownerId);
      this.db.prepare(
        "UPDATE oauth_codes SET consumed_at = COALESCE(consumed_at, ?) WHERE client_id = ? AND owner_id = ?",
      ).run(now, clientId, ownerId);
      return true;
    })();
  }
}
