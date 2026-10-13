import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  OAuthException,
  type GrantIdentifier,
  type OAuthClient,
  type OAuthClientRepository as LibraryOAuthClientRepository,
  type OAuthScope,
  type OAuthScopeRepository,
  type OAuthUser,
  type OAuthUserIdentifier,
  type OAuthUserRepository,
} from "@jmondi/oauth2-server";
import type BetterSqlite3 from "better-sqlite3";
import { OwnerRepository } from "../auth/owner-repository.js";
import { OAuthClientRepository as StoredOAuthClientRepository } from "./client-repository.js";

export function hashOpaqueSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeOpaqueSecretHash(value: string): string {
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : hashOpaqueSecret(value);
}

export class OAuthResourceContext {
  private readonly storage = new AsyncLocalStorage<string>();

  run<T>(resource: string, operation: () => T): T {
    return this.storage.run(resource, operation);
  }

  current(): string | undefined {
    return this.storage.getStore();
  }
}

export class LibraryClientRepositoryAdapter
  implements LibraryOAuthClientRepository
{
  constructor(private readonly stored: StoredOAuthClientRepository) {}

  async getByIdentifier(clientId: string): Promise<OAuthClient> {
    const client = this.stored.find(clientId);
    if (!client) throw OAuthException.invalidClient();
    return {
      id: client.clientId,
      name: client.clientId,
      secret: null,
      redirectUris: client.redirectUris,
      allowedGrants: client.grantTypes as GrantIdentifier[],
      scopes: [{ name: "mcp" }, { name: "offline_access" }],
    };
  }

  async isClientValid(
    grantType: GrantIdentifier,
    client: OAuthClient,
    clientSecret?: string,
  ): Promise<boolean> {
    return (
      clientSecret === undefined &&
      client.secret == null &&
      client.allowedGrants.includes(grantType)
    );
  }
}

export class McpScopeRepository implements OAuthScopeRepository {
  async getAllByIdentifiers(scopeNames: string[]): Promise<OAuthScope[]> {
    return scopeNames
      .filter((name) => name === "mcp" || name === "offline_access")
      .map((name) => ({ name }));
  }

  async finalize(
    scopes: OAuthScope[],
    _identifier: GrantIdentifier,
    client: OAuthClient,
  ): Promise<OAuthScope[]> {
    const allowed = new Set(client.scopes.map((scope) => scope.name));
    return scopes.filter(
      (scope) =>
        (scope.name === "mcp" || scope.name === "offline_access") &&
        allowed.has(scope.name),
    );
  }
}

export class OwnerOAuthUserRepository implements OAuthUserRepository {
  private readonly owners: OwnerRepository;

  constructor(db: BetterSqlite3.Database) {
    this.owners = new OwnerRepository(db);
  }

  async getUserByCredentials(
    identifier: OAuthUserIdentifier,
  ): Promise<OAuthUser | undefined> {
    const user = this.owners.getUserById(String(identifier));
    return user ? { id: user.id } : undefined;
  }
}
