import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { loginNonce, privateBrowserPage, safeReturnTo } from "./browser-auth.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { OwnerRepository } from "../auth/owner-repository.js";
import {
  ownerSessionToken,
  requireOwnerSession,
  type OwnerPrincipal,
  type SessionRepository,
} from "../auth/session-repository.js";
import type { ServerConfig } from "../config.js";
import {
  DeviceNotFoundError,
  type DeviceRepository,
} from "../devices/device-repository.js";
import {
  PairingAlreadyApprovedError,
  PairingExpiredError,
  PairingNotFoundError,
  type PairingService,
} from "../devices/pairing-service.js";
import type { ConnectionRegistry } from "../relay/connection-registry.js";
import type { OAuthClientRepository } from "../oauth/client-repository.js";
import { sessionCookie } from "../routes/login.js";
import { CsrfProtection } from "./csrf.js";
import { installerSource } from "./installer.js";
import { renderPairingPage, renderDevicePage } from "./onboarding.js";
import { renderConnectPage, type AgentOs, type WizardStep } from "./wizard.js";
import {
  renderDashboard,
  renderLoginPage,
  renderMcpPage,
} from "./templates.js";

type AuthenticatedDashboard = {
  principal: OwnerPrincipal;
  sessionToken: string;
};

function redirect(reply: FastifyReply, location: string, code = 302) {
  return reply.code(code).header("Location", location).send();
}

function requireDashboardAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: SessionRepository,
): AuthenticatedDashboard | null {
  const sessionToken = ownerSessionToken(request);
  const principal = requireOwnerSession(request, sessions);
  if (!sessionToken || !principal) {
    void redirect(reply, "/dashboard/login");
    return null;
  }
  return { principal, sessionToken };
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  return request.body && typeof request.body === "object"
    ? (request.body as Record<string, unknown>)
    : {};
}

function requireCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthenticatedDashboard,
  csrf: CsrfProtection,
): boolean {
  const valid = csrf.verify(auth.sessionToken, bodyRecord(request).csrf);
  if (!valid) {
    void reply.code(403).send("Invalid CSRF token");
    return false;
  }
  return true;
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  deps: {
    owners: OwnerRepository;
    sessions: SessionRepository;
    pairings: PairingService;
    devices: DeviceRepository;
    oauthClients: OAuthClientRepository;
    registry: ConnectionRegistry;
    config: ServerConfig;
  },
): void {
  const csrf = new CsrfProtection();

  app.get("/dashboard/login", async (request, reply) => {
    privateBrowserPage(reply);
    const returnTo = safeReturnTo((request.query as Record<string, unknown>).returnTo);
    const nonce = loginNonce(request) ?? randomBytes(24).toString("base64url");
    reply.header("Set-Cookie", `odr_login_nonce=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${deps.config.environment === "production" ? "; Secure" : ""}`);
    return reply.type("text/html; charset=utf-8").send(renderLoginPage(returnTo, csrf.tokenFor(nonce), "", Boolean(deps.config.githubClientId && deps.config.githubClientSecret)));
  });

  app.post("/dashboard/login", async (request, reply) => {
    privateBrowserPage(reply);
    const body = bodyRecord(request);
    const nonce = loginNonce(request);
    if (!nonce || !csrf.verify(nonce, body.csrf)) return reply.code(403).send("Invalid login CSRF token. Reload the login page.");
    const returnTo = safeReturnTo(body.returnTo);
    const password = body.password;
    if (typeof password !== "string") return reply.code(400).send("Missing passphrase");
    const owner = await deps.owners.verifyOwnerPassword(password);
    if (!owner) return reply.code(401).type("text/html; charset=utf-8").send(renderLoginPage(returnTo, csrf.tokenFor(nonce), "Invalid credentials", Boolean(deps.config.githubClientId && deps.config.githubClientSecret)));
    const token = deps.sessions.createOwnerSession(owner.id);
    reply.header("Set-Cookie", sessionCookie(token, deps.sessions.ttlMs, deps.config));
    return redirect(reply, returnTo, 303);
  });

  app.post("/dashboard/logout", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf)) return;
    deps.sessions.revokeSession(auth.sessionToken);
    reply.header("Set-Cookie", sessionCookie("", 0, deps.config));
    return redirect(reply, "/dashboard/login", 303);
  });

  // Script-enabled pages use a same-origin external asset; no inline JS.
  function interactivePage(reply: FastifyReply) {
    privateBrowserPage(reply);
    reply.header("Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  }

  app.get("/dashboard/onboarding.js", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("application/javascript; charset=utf-8").send(
      readFileSync(new URL("./onboarding-client.js", import.meta.url)));
  });

  for (const [route, os] of [
    ["/install/windows.ps1", "win"],
    ["/install/macos.sh", "mac"],
  ] as const) {
    app.get(route, async (_request, reply) => {
      if (!deps.config.agentInstallEnabled) return reply.code(404).send();
      reply.header("Cache-Control", "no-store");
      return reply.type("text/plain; charset=utf-8").send(installerSource(os));
    });
  }

  app.get("/dashboard/connect", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    interactivePage(reply);
    const query = request.query as { os?: unknown; step?: unknown; code?: unknown };
    const os: AgentOs = query.os === "mac" || query.os === "linux" ? query.os : "win";
    const step: WizardStep = query.step === "2" ? 2 : query.step === "3" ? 3 : 1;
    return reply.type("text/html; charset=utf-8").send(renderConnectPage({
      os, step, baseUrl: deps.config.publicBaseUrl,
      enabled: deps.config.agentInstallEnabled === true,
      csrf: csrf.tokenFor(auth.sessionToken),
      ...(typeof query.code === "string" ? { code: query.code } : {}),
    }));
  });

  app.get("/device", async (request, reply) => {
    const auth = requireOwnerSession(request, deps.sessions);
    if (!auth) return redirect(reply, "/dashboard/login?returnTo=" + encodeURIComponent(request.url));
    privateBrowserPage(reply);
    const codeInput = (request.query as { code?: unknown }).code;
    const code = typeof codeInput === "string" && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(codeInput)
      ? codeInput : "";
    const token = ownerSessionToken(request)!;
    return reply.type("text/html; charset=utf-8").send(renderPairingPage(code, csrf.tokenFor(token)));
  });

  app.get("/dashboard/devices/:deviceId/status", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    privateBrowserPage(reply);
    const { deviceId } = request.params as { deviceId: string };
    const device = deps.devices.findById(deviceId);
    if (!device || device.ownerId !== auth.principal.ownerId) return reply.code(404).send({ error: "NOT_FOUND" });
    const state = device.revokedAt !== null ? "REVOKED" : deps.registry.get(device.id)?.state ?? "OFFLINE";
    return reply.send({ deviceId: device.id, state });
  });

  app.get("/dashboard/devices/:deviceId", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    interactivePage(reply);
    const { deviceId } = request.params as { deviceId: string };
    const device = deps.devices.findById(deviceId);
    if (!device || device.ownerId !== auth.principal.ownerId) return reply.code(404).send();
    const state = device.revokedAt !== null ? "REVOKED" : deps.registry.get(device.id)?.state ?? "OFFLINE";
    return reply.type("text/html; charset=utf-8").send(renderDevicePage(device, state));
  });

  app.get("/dashboard", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;

    const live = new Map(
      deps.registry.snapshot().map((status) => [status.deviceId, status]),
    );
    const devices = deps.devices.listOwnedDevices(auth.principal.ownerId).map((device) => ({
      ...device,
      state:
        device.revokedAt !== null
          ? "REVOKED"
          : (live.get(device.id)?.state ?? "OFFLINE"),
    }));

    return reply
      .type("text/html; charset=utf-8")
      .send(
        renderDashboard({
          devices,
          approvedClients: deps.oauthClients.listApprovedClients(auth.principal.ownerId),
          csrf: csrf.tokenFor(auth.sessionToken),
          canChangePassword: deps.owners.getOwner()?.id === auth.principal.ownerId,
        }),
      );
  });

  app.get("/dashboard/mcp", async (request, reply) => {
    if (!requireDashboardAuth(request, reply, deps.sessions)) return;
    const mcpUrl = new URL("/mcp", deps.config.publicBaseUrl).toString();
    return reply.type("text/html; charset=utf-8").send(renderMcpPage(mcpUrl));
  });

  async function approveDashboardPairing(request: FastifyRequest, reply: FastifyReply) {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf)) return;

    const pathCode = (request.params as { userCode?: unknown }).userCode;
    const raw = pathCode ?? bodyRecord(request).userCode;
    const compact = typeof raw === "string" ? raw.trim().toUpperCase().replace("-", "") : "";
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(compact)) {
      return reply.code(400).send("Invalid pairing code");
    }
    const userCode = compact.slice(0, 4) + "-" + compact.slice(4);
    const friendlyName = bodyRecord(request).friendlyName;
    try {
      const device = deps.pairings.approvePairing(
        userCode,
        typeof friendlyName === "string" ? friendlyName.slice(0, 80) : "Unnamed Device",
        auth.principal.ownerId,
      );
      return redirect(reply, pathCode ? "/dashboard" : "/dashboard/devices/" + encodeURIComponent(device.id), 303);
    } catch (error) {
      if (error instanceof PairingNotFoundError) return reply.code(404).send("Pairing code not found. Recheck the terminal.");
      if (error instanceof PairingExpiredError) return reply.code(410).send("Pairing expired. Restart the Agent to get a new code.");
      if (error instanceof PairingAlreadyApprovedError) return reply.code(409).send("Pairing code has already been used.");
      throw error;
    }
  }
  app.post("/dashboard/pairings/approve", approveDashboardPairing);
  app.post("/dashboard/pairings/:userCode/approve", approveDashboardPairing);

  app.post("/dashboard/devices/:deviceId/rename", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf)) return;

    const { deviceId } = request.params as { deviceId: string };
    const name = bodyRecord(request).name;
    if (typeof name !== "string" || !name.trim()) {
      return reply.code(400).send("Invalid device name");
    }
    try {
      deps.devices.renameOwnedDevice(deviceId, auth.principal.ownerId, name);
      return redirect(reply, "/dashboard", 303);
    } catch (error) {
      if (error instanceof DeviceNotFoundError) return reply.code(404).send();
      throw error;
    }
  });

  app.post("/dashboard/devices/:deviceId/revoke", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf)) return;

    const { deviceId } = request.params as { deviceId: string };
    try {
      deps.devices.revokeOwnedDevice(deviceId, auth.principal.ownerId);
      return redirect(reply, "/dashboard", 303);
    } catch (error) {
      if (error instanceof DeviceNotFoundError) return reply.code(404).send();
      throw error;
    }
  });

  app.post("/dashboard/devices/revoke-all", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf)) return;
    deps.devices.revokeAllOwnedDevices(auth.principal.ownerId);
    return redirect(reply, "/dashboard", 303);
  });

  app.post("/dashboard/clients/:clientId/revoke", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf)) return;
    const { clientId } = request.params as { clientId: string };
    if (!deps.oauthClients.revokeClient(clientId, auth.principal.ownerId)) {
      return reply.code(404).send("Authorized client not found");
    }
    return redirect(reply, "/dashboard", 303);
  });

  app.post("/dashboard/password", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf)) return;

    const body = bodyRecord(request);
    if (
      typeof body.currentPassword !== "string" ||
      typeof body.newPassword !== "string" ||
      body.newPassword.length < 12
    ) {
      return reply.code(400).send("Invalid passphrase");
    }

    if (deps.owners.getOwner()?.id !== auth.principal.ownerId) return reply.code(403).send("Local Owner only");
    const changed = await deps.owners.changePassword(
      auth.principal.ownerId,
      body.currentPassword,
      body.newPassword,
    );
    if (!changed) return reply.code(400).send("Current passphrase is incorrect");

    deps.sessions.invalidateOtherSessions(
      auth.principal.ownerId,
      auth.sessionToken,
    );
    return redirect(reply, "/dashboard", 303);
  });
}
