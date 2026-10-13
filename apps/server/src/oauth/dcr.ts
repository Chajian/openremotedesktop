import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import { OAuthClientRepository } from "./client-repository.js";
import { buildAuthorizationServerMetadata } from "./metadata.js";

const DcrRequestSchema = z
  .object({
    redirect_uris: z.array(z.string().url()).min(1),
    grant_types: z.array(z.string()).default(["authorization_code"]),
    response_types: z.array(z.string()).default(["code"]),
    token_endpoint_auth_method: z.literal("none").default("none"),
  })
  // RFC 7591: ignore unused metadata/extension fields. Do not persist or
  // trust caller-supplied client IDs, secrets, names or external document URLs.
  .strip();

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function sameSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return expected.every((item) => actualSet.has(item));
}

export function registerOAuthDiscoveryAndDcr(
  app: FastifyInstance,
  clients: OAuthClientRepository,
  config: ServerConfig,
): void {
  app.get("/.well-known/oauth-authorization-server", async () =>
    buildAuthorizationServerMetadata(config.publicBaseUrl),
  );

  app.post("/oauth/register", async (request, reply) => {
    const parsed = DcrRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_client_metadata",
        error_description: "Invalid dynamic client registration payload",
      });
    }

    const input = parsed.data;
    const valid =
      input.redirect_uris.every(isAllowedRedirectUri) &&
      input.grant_types.includes("authorization_code") &&
      input.grant_types.every((grant) => grant === "authorization_code" || grant === "refresh_token") &&
      new Set(input.grant_types).size === input.grant_types.length &&
      sameSet(input.response_types, ["code"]);

    if (!valid) {
      return reply.code(400).send({
        error: "invalid_client_metadata",
        error_description: "Unsupported grant, response type, or redirect URI",
      });
    }

    const client = clients.create({
      redirectUris: input.redirect_uris,
      grantTypes: input.grant_types,
      responseTypes: input.response_types,
      tokenEndpointAuthMethod: "none",
    });

    return reply.code(201).send({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    });
  });
}
