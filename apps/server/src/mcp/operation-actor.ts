import type { AuthInfo } from "@modelcontextprotocol/server";
import type { OAuthService } from "../oauth/authorization-server.js";
import type { OperationActor } from "../operations/access-policy.js";

/** Preserve the audience selected by HTTP authentication, including alternate domains. */
export function createOperationActor(oauth: Pick<OAuthService,"verifyAccessToken">, info: AuthInfo | undefined): OperationActor | null {
  const userId = info?.extra?.ownerId;
  if (!info?.resource || !info.token || !info.clientId || typeof userId !== "string") return null;
  const {token, clientId} = info;
  const resource = info.resource.toString();
  return {userId, clientId, authorize: async () => {
    try {
      const current = await oauth.verifyAccessToken(token,resource);
      return current.ownerId === userId && current.clientId === clientId;
    } catch { return false; }
  }};
}
