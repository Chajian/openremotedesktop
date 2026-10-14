import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";
import { publicBaseUrlForHost, type ServerConfig } from "../config.js";
import { buildAuthorizationServerMetadata } from "../oauth/metadata.js";

export function mcpResourceUrl(config: ServerConfig, host?: string): URL {
  return new URL("/mcp", publicBaseUrlForHost(config, host));
}

export function mcpResourceMetadataUrl(config: ServerConfig, host?: string): string {
  return getOAuthProtectedResourceMetadataUrl(mcpResourceUrl(config, host));
}

export function buildMcpProtectedResourceMetadata(
  config: ServerConfig,
  host?: string,
): OAuthProtectedResourceMetadata {
  return buildOAuthProtectedResourceMetadata({
    oauthMetadata: buildAuthorizationServerMetadata(config.publicBaseUrl),
    resourceServerUrl: mcpResourceUrl(config, host),
    scopesSupported: ["mcp"],
    resourceName: "Open Desktop Remote",
    dangerouslyAllowInsecureIssuerUrl:
      config.environment !== "production" &&
      config.publicBaseUrl.protocol === "http:",
  });
}
