import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { buildAuthorizationServerMetadata } from "../oauth/metadata.js";

export function mcpResourceUrl(config: ServerConfig): URL {
  return new URL("/mcp", config.publicBaseUrl);
}

export function mcpResourceMetadataUrl(config: ServerConfig): string {
  return getOAuthProtectedResourceMetadataUrl(mcpResourceUrl(config));
}

export function buildMcpProtectedResourceMetadata(
  config: ServerConfig,
): OAuthProtectedResourceMetadata {
  return buildOAuthProtectedResourceMetadata({
    oauthMetadata: buildAuthorizationServerMetadata(config.publicBaseUrl),
    resourceServerUrl: mcpResourceUrl(config),
    scopesSupported: ["mcp"],
    resourceName: "Open Desktop Remote",
    dangerouslyAllowInsecureIssuerUrl:
      config.environment !== "production" &&
      config.publicBaseUrl.protocol === "http:",
  });
}
