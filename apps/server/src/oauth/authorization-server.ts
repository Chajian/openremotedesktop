import { randomBytes } from "node:crypto";
import {
  AuthCodeGrant,
  AuthorizationServer,
  DEFAULT_AUTHORIZATION_SERVER_OPTIONS,
  DateInterval,
  JwtService,
  RefreshTokenGrant,
  type AuthorizationServerOptions,
  type ExtraAccessTokenFields,
  type OAuthClient,
  type OAuthScope,
  type OAuthToken,
} from "@jmondi/oauth2-server";
import type BetterSqlite3 from "better-sqlite3";
import type { ServerConfig } from "../config.js";
import { OAuthClientRepository as StoredOAuthClientRepository } from "./client-repository.js";
import { SqliteOAuthAuthCodeRepository } from "./auth-code-repository.js";
import {
  LibraryClientRepositoryAdapter,
  McpScopeRepository,
  OAuthResourceContext,
  OwnerOAuthUserRepository,
} from "./model.js";
import {
  SqliteOAuthTokenRepository,
  type AuthInfo,
} from "./token-repository.js";

class OpaqueAccessAuthCodeGrant extends AuthCodeGrant {
  protected override async encryptAccessToken(
    _client: OAuthClient,
    accessToken: OAuthToken,
    _scopes: OAuthScope[],
    _extraJwtFields: ExtraAccessTokenFields,
  ): Promise<string> {
    return accessToken.accessToken;
  }
}

class OpaqueAccessRefreshTokenGrant extends RefreshTokenGrant {
  protected override async encryptAccessToken(
    _client: OAuthClient,
    accessToken: OAuthToken,
    _scopes: OAuthScope[],
    _extraJwtFields: ExtraAccessTokenFields,
  ): Promise<string> {
    return accessToken.accessToken;
  }
}

export type OAuthService = {
  server: AuthorizationServer;
  registeredClients: StoredOAuthClientRepository;
  authCodes: SqliteOAuthAuthCodeRepository;
  tokens: SqliteOAuthTokenRepository;
  resourceContext: OAuthResourceContext;
  protectedResource: string;
  allowedResources: ReadonlySet<string>;
  issuer: string;
  verifyAccessToken(token: string, resource: string): Promise<AuthInfo>;
};

export function createOAuthService(
  db: BetterSqlite3.Database,
  config: ServerConfig,
): OAuthService {
  const storedClients = new StoredOAuthClientRepository(db);
  const clients = new LibraryClientRepositoryAdapter(storedClients);
  const scopes = new McpScopeRepository();
  const users = new OwnerOAuthUserRepository(db);
  const resourceContext = new OAuthResourceContext();
  const authCodes = new SqliteOAuthAuthCodeRepository(
    db,
    clients,
    users,
    resourceContext,
  );
  const tokens = new SqliteOAuthTokenRepository(
    db,
    clients,
    authCodes,
    resourceContext,
  );

  const issuer = new URL("/", config.publicBaseUrl).toString();
  const protectedResource = new URL("/mcp", config.publicBaseUrl).toString();
  const allowedResources = new Set([
    config.publicBaseUrl, ...(config.additionalPublicBaseUrls ?? []),
  ].map((url) => new URL("/mcp", url).toString()));
  const options: AuthorizationServerOptions = {
    ...DEFAULT_AUTHORIZATION_SERVER_OPTIONS,
    issuer,
    requiresPKCE: true,
    requiresS256: true,
    useOpaqueAuthorizationCodes: true,
    useOpaqueRefreshTokens: true,
  };
  const jwt = new JwtService(randomBytes(48).toString("base64url"));
  const server = new AuthorizationServer(clients, tokens, scopes, jwt, options);

  delete server.enabledGrantTypes.client_credentials;
  delete server.grantTypeAccessTokenTTL.client_credentials;

  const authCodeGrant = new OpaqueAccessAuthCodeGrant(
    authCodes,
    users,
    clients,
    tokens,
    scopes,
    jwt,
    options,
    new DateInterval("10m"),
  );
  const refreshGrant = new OpaqueAccessRefreshTokenGrant(
    clients,
    tokens,
    scopes,
    jwt,
    options,
  );

  server.enableGrantType(
    { grant: authCodeGrant },
    new DateInterval("1h"),
  );
  server.enableGrantType(
    { grant: refreshGrant },
    new DateInterval("1h"),
  );

  return {
    server,
    registeredClients: storedClients,
    authCodes,
    tokens,
    resourceContext,
    protectedResource,
    allowedResources,
    issuer,
    verifyAccessToken: (token, resource) =>
      tokens.verifyAccessToken(token, resource),
  };
}
