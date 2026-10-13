import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { OAuthService } from "../oauth/authorization-server.js";

export function createMcpTokenVerifier(
  oauth: OAuthService,
  resource: URL,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const info = await oauth.verifyAccessToken(token, resource.toString());
        const stored = await oauth.tokens.getByAccessToken(token);
        return {
          token,
          clientId: info.clientId,
          scopes: info.scopes,
          expiresAt: Math.floor(stored.accessTokenExpiresAt.getTime() / 1000),
          resource,
          extra: { ownerId: info.ownerId },
        };
      } catch {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "Invalid or unauthorized access token",
        );
      }
    },
  };
}
