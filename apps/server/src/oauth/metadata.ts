export type OAuthAuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  grant_types_supported: string[];
  response_types_supported: string[];
  scopes_supported: string[];
  authorization_response_iss_parameter_supported: true;
};

export function buildAuthorizationServerMetadata(
  baseUrl: URL,
): OAuthAuthorizationServerMetadata {
  const issuer = new URL("/", baseUrl).toString();
  return {
    issuer,
    authorization_endpoint: new URL("/oauth/authorize", baseUrl).toString(),
    token_endpoint: new URL("/oauth/token", baseUrl).toString(),
    registration_endpoint: new URL("/oauth/register", baseUrl).toString(),
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    scopes_supported: ["mcp", "offline_access"],
    authorization_response_iss_parameter_supported: true,
  };
}
