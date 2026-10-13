import {
  McpServer,
  bearerAuthChallengeResponse,
  createMcpHandler,
  verifyBearerToken,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ServerConfig } from "../config.js";
import type { OAuthService } from "../oauth/authorization-server.js";
import { createMcpTokenVerifier } from "./auth-verifier.js";
import {
  registerDesktopCommanderTools,
  type DesktopToolDependencies,
} from "./register-desktop-tools.js";
import {
  buildMcpProtectedResourceMetadata,
  mcpResourceMetadataUrl,
  mcpResourceUrl,
} from "./resource-metadata.js";

export type McpServerDependencies = DesktopToolDependencies;

export function buildMcpServer(
  deps?: McpServerDependencies,
): McpServer {
  const server = new McpServer({
    name: "open-desktop-remote",
    version: "0.1.0",
  });
  if (deps) registerDesktopCommanderTools(server, deps);
  return server;
}

function createStatelessMcpHandler(
  deps: McpServerDependencies,
): McpHttpHandler {
  return createMcpHandler(() => buildMcpServer(deps), {
    legacy: "stateless",
  });
}

async function sendWebResponse(
  response: Response,
  reply: FastifyReply,
): Promise<FastifyReply> {
  response.headers.forEach((value, key) => reply.header(key, value));
  const bytes = Buffer.from(await response.arrayBuffer());
  return reply.code(response.status).send(bytes);
}

async function authenticateMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  oauth: OAuthService,
  config: ServerConfig,
): Promise<AuthInfo | null> {
  const resource = mcpResourceUrl(config);
  const resourceMetadataUrl = mcpResourceMetadataUrl(config);
  reply.header("Cache-Control", "no-store");
  if (!request.headers.authorization?.trim()) {
    // A first request is an OAuth discovery challenge, not a bad-token error.
    // RFC 6750 section 3.1: omit error details when credentials are absent.
    await reply.code(401).header(
      "WWW-Authenticate",
      `Bearer scope="mcp", resource_metadata="${resourceMetadataUrl}"`,
    ).send();
    return null;
  }
  try {
    return await verifyBearerToken(request.headers.authorization, {
      verifier: createMcpTokenVerifier(oauth, resource),
      requiredScopes: ["mcp"],
      resourceMetadataUrl,
    });
  } catch (error) {
    await sendWebResponse(
      bearerAuthChallengeResponse(error, {
        requiredScopes: ["mcp"],
        resourceMetadataUrl,
      }),
      reply,
    );
    return null;
  }
}

function toWebRequest(
  request: FastifyRequest,
  config: ServerConfig,
): Request {
  const url = new URL(request.url, config.publicBaseUrl);
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) headers.append(name, value);
    } else {
      headers.set(name, String(rawValue));
    }
  }
  return new Request(url, {
    method: request.method,
    headers,
  });
}

export function registerMcpRoutes(
  app: FastifyInstance,
  oauth: OAuthService,
  config: ServerConfig,
  toolDeps: McpServerDependencies,
): void {
  const handler = createStatelessMcpHandler(toolDeps);

  app.addHook("onClose", async () => {
    await handler.close();
  });

  // Support both path-scoped discovery and clients probing the origin root.
  // Both documents retain /mcp as the canonical audience; no auth is relaxed.
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    app.get(path, async (_request, reply) => reply.send(buildMcpProtectedResourceMetadata(config)));
  }

  app.route({
    method: ["GET", "POST"],
    url: "/mcp",
    handler: async (request, reply) => {
      const auth = await authenticateMcpRequest(request, reply, oauth, config);
      if (!auth) return;

      const response = await handler.fetch(toWebRequest(request, config), {
        authInfo: auth,
        parsedBody: request.body,
      });
      return sendWebResponse(response, reply);
    },
  });
}
