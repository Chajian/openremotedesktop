import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type BetterSqlite3 from "better-sqlite3";
import { OwnerRepository } from "./auth/owner-repository.js";
import { registerGitHubAuthRoutes } from "./auth/github-auth.js";
import { SessionRepository } from "./auth/session-repository.js";
import { publicBaseUrlForHost, type ServerConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { registerDashboardAssets } from "./dashboard/assets.js";
import { registerHealthRoutes } from "./health/routes.js";
import { createOAuthService } from "./oauth/authorization-server.js";
import { OAuthClientRepository } from "./oauth/client-repository.js";
import { registerOAuthDiscoveryAndDcr } from "./oauth/dcr.js";
import { registerOAuthFlowRoutes } from "./oauth/oauth-routes.js";
import { ConnectionRegistry } from "./relay/connection-registry.js";
import { RequestBroker } from "./relay/request-broker.js";
import { registerRelayRoute } from "./relay/relay-route.js";
import { DeviceAuthService } from "./devices/device-auth.js";
import { DeviceRepository } from "./devices/device-repository.js";
import { PairingService } from "./devices/pairing-service.js";
import { registerBootstrapRoutes } from "./routes/bootstrap.js";
import { registerDevicePairingRoutes } from "./routes/device-pairing.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerLoginRoutes } from "./routes/login.js";
import { registerMcpRoutes } from "./mcp/mcp-handler.js";
import { OperationRepository } from "./operations/operation-repository.js";
import { OperationService } from "./operations/operation-service.js";
import { OwnedOperationAccessPolicy } from "./operations/access-policy.js";
import { createOperationActor } from "./mcp/operation-actor.js";
import { createServerLogger } from "./logging.js";

export type AppDependencies = {
  db: BetterSqlite3.Database;
  config: ServerConfig;
};

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(formbody);

  // Browser-origin checks for cookie-authorized JSON APIs. Session tokens alone
  // do not prove that a state-changing browser request came from this origin.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const method = request.method;
    const protectedApi = (method === "POST" && (
      path === "/api/login" ||
      path === "/api/bootstrap" ||
      /^\/api\/device-pairings\/[^/]+\/approve$/.test(path) ||
      path.startsWith("/api/devices/")
    )) || (method === "PATCH" && path.startsWith("/api/devices/"));
    if (!protectedApi) return;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    const expectedOrigin = publicBaseUrlForHost(deps.config, request.headers.host).origin;
    if ((origin && origin !== expectedOrigin) ||
        (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
      return reply.code(403).send({ error: "CROSS_ORIGIN_REQUEST" });
    }
  });

  const owners = new OwnerRepository(deps.db);
  const sessions = new SessionRepository(deps.db);
  const oauthClients = new OAuthClientRepository(deps.db);
  const oauth = createOAuthService(deps.db, deps.config);
  const devices = new DeviceRepository(deps.db);
  const pairings = new PairingService(
    deps.db,
    devices,
    deps.config.publicBaseUrl,
  );
  const deviceAuth = new DeviceAuthService(deps.db, devices);
  const registry = new ConnectionRegistry();
  const broker = new RequestBroker(registry);
  const logger = createServerLogger();
  const operationRepository = new OperationRepository(deps.db);
  const operations = new OperationService(operationRepository, broker, new OwnedOperationAccessPolicy(devices), {logger});
  operationRepository.cleanup();
  const operationCleanup = setInterval(() => operationRepository.cleanup(), 60_000);
  operationCleanup.unref();
  app.addHook("onClose", async () => clearInterval(operationCleanup));

  registerBootstrapRoutes(app, owners);
  registerLoginRoutes(app, owners, sessions, deps.config);
  registerGitHubAuthRoutes(app, deps.db, owners, sessions, deps.config);
  registerOAuthDiscoveryAndDcr(app, oauthClients, deps.config);
  registerOAuthFlowRoutes(app, oauth, sessions, deps.config);
  registerDevicePairingRoutes(app, pairings, sessions, deps.config);
  registerDeviceRoutes(app, devices, deviceAuth, sessions);
  void app.register(async (relayApp) => {
    await relayApp.register(websocket);
    registerRelayRoute(relayApp, deviceAuth, devices, registry, broker, logger);
  });
  registerMcpRoutes(app, oauth, deps.config, {
    devices,
    registry,
    broker,
    logger,
    operations,
    operationActor: (info) => createOperationActor(oauth, info),
    authOwnerId: (info) => {
      const ownerId = info?.extra?.ownerId;
      return typeof ownerId === "string" ? ownerId : null;
    },
  });
  registerHealthRoutes(app, deps.db);
  registerDashboardAssets(app);
  registerDashboardRoutes(app, {
    owners,
    sessions,
    pairings,
    devices,
    oauthClients,
    registry,
    config: deps.config,
  });

  return app;
}
