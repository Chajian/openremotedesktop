import {
  OAuthException,
  OAuthRequest,
  type ResponseInterface,
} from "@jmondi/oauth2-server";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { ownerSessionToken, requireOwnerSession, type SessionRepository } from "../auth/session-repository.js";
import type { ServerConfig } from "../config.js";
import type { OAuthService } from "./authorization-server.js";
import { CsrfProtection } from "../dashboard/csrf.js";
import { privateBrowserPage, safeReturnTo } from "../dashboard/browser-auth.js";
import { renderConsentPage } from "./consent-page.js";
import { renderGeminiNavigation, usesGeminiNavigation, validateGeminiLocation, type ConsentOutcome } from "./callback-response.js";

function oauthRequest(request: FastifyRequest): OAuthRequest {
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([, value]) => value !== undefined),
  );
  return new OAuthRequest({
    query: (request.query ?? {}) as Record<string, unknown>,
    body: (request.body ?? {}) as Record<string, unknown>,
    headers,
  });
}

function sendOAuthResponse(
  reply: FastifyReply,
  response: ResponseInterface,
): FastifyReply {
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined) reply.header(key, value);
  }
  if (response.status === 302) {
    return reply.code(302).send();
  }
  return reply.code(response.status).send(response.body);
}

function sendGeminiNavigation(
  reply: FastifyReply,
  config: ServerConfig,
  redirectUri: string | undefined,
  location: unknown,
  outcome: ConsentOutcome,
  issuer: string,
  state: string | undefined,
  headers: ResponseInterface["headers"] = {},
): FastifyReply | undefined {
  if (!redirectUri || !usesGeminiNavigation(redirectUri, config.geminiCallbackCompatEnabled === true)) return;
  const target = validateGeminiLocation(redirectUri, location, outcome, issuer, state);
  const replacedHeaders = new Set(["location", "content-type", "content-length", "cache-control",
    "referrer-policy", "x-frame-options", "x-content-type-options", "content-security-policy"]);
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !replacedHeaders.has(key.toLowerCase())) reply.header(key, value);
  }
  reply.removeHeader("location");
  reply.header("Cache-Control", "no-store");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  return reply.code(200).type("text/html; charset=utf-8").send(renderGeminiNavigation(target, outcome));
}

function sendOAuthError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof OAuthException) {
    return reply.code(error.status).send({
      error: error.errorType,
      error_description: error.errorDescription ?? error.error,
    });
  }
  return reply.code(500).send({
    error: "server_error",
    error_description: "An unexpected OAuth error occurred",
  });
}

function appendIssuer(response: ResponseInterface, issuer: string): void {
  const location = response.headers.location;
  if (response.status !== 302 || typeof location !== "string") return;
  const url = new URL(location);
  url.searchParams.set("iss", issuer);
  response.headers.location = url.toString();
}

export function registerOAuthFlowRoutes(
  app: FastifyInstance,
  oauth: OAuthService,
  sessions: SessionRepository,
  config: ServerConfig,
): void {
  const consentCsrf = new CsrfProtection();
  app.route({ method: ["GET", "POST"], url: "/oauth/authorize", handler: async (request, reply) => {
    privateBrowserPage(reply);
    const isPost = request.method === "POST";
    const body = (request.body ?? {}) as Record<string, unknown>;
    const returnTo = isPost ? safeReturnTo(body.returnTo) : request.url;
    const principal = requireOwnerSession(request, sessions);
    const sessionToken = ownerSessionToken(request);
    if (!principal || !sessionToken) {
      return reply.code(302).header("location", `/dashboard/login?returnTo=${encodeURIComponent(returnTo)}`).send();
    }
    if (isPost && (!returnTo.startsWith("/oauth/authorize?") ||
        !consentCsrf.verify(`${sessionToken}\n${returnTo}`, body.csrf))) {
      return reply.code(403).send("Invalid consent CSRF token");
    }
    const query = isPost
      ? Object.fromEntries(new URL(returnTo, oauth.issuer).searchParams)
      : request.query as Record<string, unknown>;
    const resource = query.resource;
    if (typeof resource !== "string" || !oauth.allowedResources.has(resource)) {
      return reply.code(400).send({ error: "invalid_request", error_description: "resource must identify this MCP endpoint" });
    }
    try {
      const validated = await oauth.server.validateAuthorizationRequest(new OAuthRequest({ query }));
      // Allow only the validated client origin for the form POST callback redirect.
      privateBrowserPage(reply, new URL(String(query.redirect_uri)).origin);
      if (!isPost) {
        return reply.type("text/html; charset=utf-8").send(renderConsentPage({
          returnTo, csrf: consentCsrf.tokenFor(`${sessionToken}\n${returnTo}`),
          clientId: String(query.client_id), redirectUri: String(query.redirect_uri),
          scope: typeof query.scope === "string" ? query.scope : "mcp",
        }));
      }
      if (body.decision === "deny") {
        const url = new URL(String(query.redirect_uri));
        url.searchParams.set("error", "access_denied");
        if (typeof query.state === "string") url.searchParams.set("state", query.state);
        url.searchParams.set("iss", oauth.issuer);
        const location = url.toString();
        return sendGeminiNavigation(reply, config, validated.redirectUri, location, "denied",
          oauth.issuer, typeof query.state === "string" ? query.state : undefined)
          ?? reply.code(302).header("location", location).send();
      }
      if (body.decision !== "approve") return reply.code(400).send({ error: "invalid_request" });
      validated.user = { id: principal.ownerId };
      validated.isAuthorizationApproved = true;
      const response = await oauth.resourceContext.run(resource, () => oauth.server.completeAuthorizationRequest(validated));
      if (response.status === 302) {
        // Explicit Owner consent is the only way to approve an OAuth client.
        oauth.registeredClients.approveClient(String(query.client_id), principal.ownerId);
      }
      appendIssuer(response, oauth.issuer);
      if (response.status === 302) {
        // The library omits an empty state on successful authorization.
        const navigation = sendGeminiNavigation(reply, config, validated.redirectUri, response.headers.location,
          "approved", oauth.issuer, validated.state || undefined, response.headers);
        if (navigation) return navigation;
      }
      return sendOAuthResponse(reply, response);
    } catch (error) {
      return sendOAuthError(error, reply);
    }
  } });

  app.post("/oauth/token", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const grantType = body.grant_type;
    let resource: string | null = null;

    if (grantType === "authorization_code" && typeof body.code === "string") {
      resource = oauth.authCodes.resourceForCode(body.code);
    } else if (
      grantType === "refresh_token" &&
      typeof body.refresh_token === "string"
    ) {
      resource = oauth.tokens.resourceForRefresh(body.refresh_token);
    }

    try {
      const response = await oauth.resourceContext.run(
        resource ?? oauth.protectedResource,
        () => oauth.server.respondToAccessTokenRequest(oauthRequest(request)),
      );
      return sendOAuthResponse(reply, response);
    } catch (error) {
      return sendOAuthError(error, reply);
    }
  });
}
