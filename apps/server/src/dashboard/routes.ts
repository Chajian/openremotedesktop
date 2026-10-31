import { randomBytes } from "node:crypto";
import { renderOverview } from "./views/overview.js";
import { renderDevices, type LiveDevice } from "./views/devices.js";
import { renderDeviceDetail } from "./views/device-detail.js";
import { renderMcp, displayClient } from "./views/mcp.js";
import { renderSettings, type PasswordError } from "./views/settings.js";
import { renderConfirm } from "./views/confirm.js";
import { renderSupportDashboard, renderSupportCreated } from "./views/support.js";
import { SupportNotFoundError, type SupportService } from "../support/support-service.js";
import type { NavKey, ShellContext } from "./ui/components.js";
import { renderLogin } from "./views/login.js";
import { renderErrorPage } from "./views/error.js";
import { langCookie, safeLangReturnTo, localeFromRequest, t } from "./ui/i18n.js";
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
import { publicBaseUrlForHost, type ServerConfig } from "../config.js";
import type { DeviceManagementService } from "../devices/device-management-service.js";
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
import { supportDownloadUrl, supportsDownloadedLauncher } from "../support/support-launcher.js";
import { installerSource, downloadSourceFromQuery } from "./installer.js";
import { renderPairingPage } from "./onboarding.js";
import { renderConnectPage, type AgentOs, type WizardStep } from "./wizard.js";

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
  ctx: ShellContext,
  backHref: string,
): boolean {
  const valid = csrf.verify(auth.sessionToken, bodyRecord(request).csrf);
  if (!valid) {
    void reply.code(403).type("text/html; charset=utf-8").send(renderErrorPage({ locale: ctx.locale, status: 403, kind: "expired", ctx, backHref }));
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
    deviceManagement: DeviceManagementService;
    support: SupportService;
    oauthClients: OAuthClientRepository;
    registry: ConnectionRegistry;
    config: ServerConfig;
  },
): void {
  const csrf = new CsrfProtection();

  function ownedDevices(ownerId: string): LiveDevice[] {
    const live = new Map(deps.registry.snapshot().map(s => [s.deviceId, s.state]));
    const temporary = new Set(deps.support.activeDeviceIds(ownerId));
    return deps.devices.listOwnedDevices(ownerId).map(d => ({ ...d,
      state: d.revokedAt !== null ? "REVOKED" : (live.get(d.id) ?? "OFFLINE"),
      isSupport: temporary.has(d.id),
    }));
  }
  function shell(request: FastifyRequest, auth: AuthenticatedDashboard, nav: NavKey | null): ShellContext {
    return { locale: localeFromRequest(request), account: deps.owners.getAccountSummary(auth.principal.ownerId), nav, path: request.url, csrf: csrf.tokenFor(auth.sessionToken), publicBaseUrl: publicBaseUrlForHost(deps.config, request.headers.host), supportEnabled: deps.config.supportEnabled === true || deps.support.hasActiveSupport(auth.principal.ownerId) };
  }
  function dashboardError(request: FastifyRequest, reply: FastifyReply, auth: AuthenticatedDashboard, status: number, kind: "invalid" | "notFound" | "forbidden", backHref = "/dashboard/devices") {
    const ctx = shell(request, auth, backHref.startsWith("/dashboard/mcp") ? "chatgpt" : backHref.startsWith("/dashboard/settings") ? "settings" : "devices");
    return reply.code(status).type("text/html; charset=utf-8").send(renderErrorPage({ locale: ctx.locale, status, kind, backHref, ctx }));
  }
  function detail(request: FastifyRequest, reply: FastifyReply, auth: AuthenticatedDashboard, device: LiveDevice, renameError = false) {
    interactivePage(reply);
    return reply.type("text/html; charset=utf-8").send(renderDeviceDetail(shell(request, auth, "devices"), { device, now: Date.now(), renameError, paired: (request.query as Record<string, unknown>).paired === "1", hasClients: deps.oauthClients.listApprovedClients(auth.principal.ownerId).length > 0 }));
  }

  app.get("/dashboard/support", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const sessions = deps.support.listOwned(auth.principal.ownerId);
    const statuses = new Map(deps.registry.snapshot().map(s => [s.deviceId, s.state]));
    return reply.type("text/html; charset=utf-8").send(
      renderSupportDashboard(shell(request, auth, "support"), sessions, statuses, deps.config.supportEnabled === true));
  });

  app.post("/dashboard/support/create", async (request, reply) => {
    if (!deps.config.supportEnabled) return reply.code(404).send();
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, "support"), "/dashboard/support")) return;
    const label = bodyRecord(request).label;
    if (typeof label !== "string" || !label.trim() || label.length > 80)
      return dashboardError(request, reply, auth, 400, "invalid", "/dashboard/support");
    const { session, invite } = deps.support.create(auth.principal.ownerId, label);
    interactivePage(reply);
    return reply.type("text/html; charset=utf-8").send(
      renderSupportCreated(shell(request, auth, "support"), invite, session,
        deps.config.agentInstallEnabled && supportsDownloadedLauncher(deps.config.supportAgentVersion)
          ? supportDownloadUrl(publicBaseUrlForHost(deps.config, request.headers.host), invite) : undefined));
  });

  app.get("/dashboard/support/:sessionId/end", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const { sessionId } = request.params as {sessionId:string};
    const session = deps.support.listOwned(auth.principal.ownerId).find(s => s.id === sessionId);
    if (!session) return dashboardError(request, reply, auth, 404, "notFound", "/dashboard/support");
    const ctx = shell(request, auth, "support");
    return reply.type("text/html; charset=utf-8").send(renderConfirm(ctx, {
      title: t(ctx.locale, "support.endConfirm", {name:session.label}),
      bullets: [t(ctx.locale,"support.endConsequences"), t(ctx.locale,"confirm.noFiles")],
      action: "/dashboard/support/" + encodeURIComponent(sessionId) + "/end",
      cancelHref: "/dashboard/support", submitLabel:t(ctx.locale,"support.end"),danger:true,
    }));
  });

  app.post("/dashboard/support/:sessionId/end", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, "support"), "/dashboard/support")) return;
    const { sessionId } = request.params as { sessionId: string };
    try {
      deps.support.endOwned(sessionId, auth.principal.ownerId);
      return redirect(reply, "/dashboard/support", 303);
    } catch (error) {
      if (error instanceof SupportNotFoundError)
        return dashboardError(request, reply, auth, 404, "notFound", "/dashboard/support");
      throw error;
    }
  });

  app.get("/dashboard/devices", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const status = (request.query as Record<string, unknown>).status;
    const filter = status === "online" || status === "attention" || status === "revoked" ? status : "all";
    const deleted = (request.query as Record<string, unknown>).deleted === "1";
    return reply.type("text/html; charset=utf-8").send(renderDevices(shell(request, auth, "devices"), { devices: ownedDevices(auth.principal.ownerId), filter, now: Date.now(), deleted }));
  });
  app.get("/dashboard/devices/:deviceId", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const { deviceId } = request.params as { deviceId: string };
    const device = ownedDevices(auth.principal.ownerId).find(d => d.id === deviceId);
    if (!device) return dashboardError(request, reply, auth, 404, "notFound");
    return detail(request, reply, auth, device);
  });
  app.get("/dashboard/devices/:deviceId/revoke", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const { deviceId } = request.params as { deviceId: string };
    const device = ownedDevices(auth.principal.ownerId).find(d => d.id === deviceId);
    if (!device) return dashboardError(request, reply, auth, 404, "notFound");
    const ctx = shell(request, auth, "devices");
    const path = "/dashboard/devices/" + encodeURIComponent(device.id);
    return reply.type("text/html; charset=utf-8").send(renderConfirm(ctx, { title: t(ctx.locale, "confirm.revokeDevice", { name: device.name }), bullets: (["confirm.credentials", "confirm.deviceAccess", "confirm.noFiles", "confirm.irreversible"] as const).map(key => t(ctx.locale, key)), action: path + "/revoke", submitLabel: t(ctx.locale, "device.revoke"), cancelHref: path, danger: true }));
  });

  app.get("/dashboard/devices/:deviceId/delete", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const { deviceId } = request.params as { deviceId: string };
    const device = ownedDevices(auth.principal.ownerId).find(d => d.id === deviceId);
    if (!device) return dashboardError(request, reply, auth, 404, "notFound");
    const ctx = shell(request, auth, "devices");
    const path = "/dashboard/devices/" + encodeURIComponent(device.id);
    return reply.type("text/html; charset=utf-8").send(renderConfirm(ctx, {
      title: t(ctx.locale, "confirm.deleteDevice", { name: device.name, id: device.id.slice(-8) }),
      bullets: (["confirm.deleteAccess", "confirm.deleteHidden", "confirm.noFiles", "confirm.irreversible"] as const).map(key => t(ctx.locale, key)),
      action: path + "/delete", submitLabel: t(ctx.locale, "device.delete"),
      cancelHref: path, danger: true,
    }));
  });

  app.get("/dashboard/lang", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const to = query.to === "en" || query.to === "zh-CN" ? query.to : null;
    if (to) reply.header("Set-Cookie", langCookie(to, deps.config.environment === "production"));
    return redirect(reply, safeLangReturnTo(query.returnTo), 303);
  });

  app.get("/dashboard/login", async (request, reply) => {
    privateBrowserPage(reply);
    const returnTo = safeReturnTo((request.query as Record<string, unknown>).returnTo);
    const nonce = loginNonce(request) ?? randomBytes(24).toString("base64url");
    reply.header("Set-Cookie", `odr_login_nonce=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${deps.config.environment === "production" ? "; Secure" : ""}`);
    return reply.type("text/html; charset=utf-8").send(renderLogin({ locale: localeFromRequest(request), returnTo, csrf: csrf.tokenFor(nonce), githubEnabled: Boolean(deps.config.githubClientId && deps.config.githubClientSecret), error: null }));
  });

  app.post("/dashboard/login", async (request, reply) => {
    privateBrowserPage(reply);
    const body = bodyRecord(request);
    const nonce = loginNonce(request);
    if (!nonce || !csrf.verify(nonce, body.csrf)) return reply.code(403).type("text/html; charset=utf-8").send(renderErrorPage({ locale: localeFromRequest(request), status: 403, kind: "loginExpired", backHref: "/dashboard/login" }));
    const returnTo = safeReturnTo(body.returnTo);
    const password = body.password;
    if (typeof password !== "string") return reply.code(400).type("text/html; charset=utf-8").send(renderLogin({ locale: localeFromRequest(request), returnTo, csrf: csrf.tokenFor(nonce), githubEnabled: Boolean(deps.config.githubClientId && deps.config.githubClientSecret), error: "missing" }));
    const owner = await deps.owners.verifyOwnerPassword(password);
    if (!owner) return reply.code(401).type("text/html; charset=utf-8").send(renderLogin({ locale: localeFromRequest(request), returnTo, csrf: csrf.tokenFor(nonce), githubEnabled: Boolean(deps.config.githubClientId && deps.config.githubClientSecret), error: "invalid" }));
    const token = deps.sessions.createOwnerSession(owner.id);
    reply.header("Set-Cookie", sessionCookie(token, deps.sessions.ttlMs, deps.config));
    return redirect(reply, returnTo, 303);
  });

  app.post("/dashboard/logout", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, "overview"), "/dashboard")) return;
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
    const query = request.query as { os?: unknown; step?: unknown; code?: unknown; downloadSource?: unknown };
    const os: AgentOs = query.os === "mac" || query.os === "linux" ? query.os : "win";
    const step: WizardStep = query.step === "2" ? 2 : query.step === "3" ? 3 : 1;
    return reply.type("text/html; charset=utf-8").send(renderConnectPage({
      os, step, baseUrl: publicBaseUrlForHost(deps.config, request.headers.host),
      downloadSource: downloadSourceFromQuery(query.downloadSource),
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
    if (!device || device.deletedAt !== null || device.ownerId !== auth.principal.ownerId) return reply.code(404).send({ error: "NOT_FOUND" });
    const state = device.revokedAt !== null ? "REVOKED" : deps.registry.get(device.id)?.state ?? "OFFLINE";
    return reply.send({ deviceId: device.id, state });
  });


  app.get("/dashboard", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    return reply.type("text/html; charset=utf-8").send(renderOverview(shell(request, auth, "overview"), { devices: ownedDevices(auth.principal.ownerId), clients: deps.oauthClients.listApprovedClients(auth.principal.ownerId), now: Date.now() }));
  });

  function settingsPage(request: FastifyRequest, reply: FastifyReply, auth: AuthenticatedDashboard, passwordError: PasswordError | null = null) {
    return reply.type("text/html; charset=utf-8").send(renderSettings(shell(request, auth, "settings"), { canChangePassword: deps.owners.getOwner()?.id === auth.principal.ownerId, saved: passwordError === null && (request.query as Record<string, unknown>).saved === "password", passwordError, liveDeviceCount: ownedDevices(auth.principal.ownerId).filter(d => d.state !== "REVOKED").length }));
  }
  app.get("/dashboard/mcp", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const mcpUrl = new URL("/mcp", publicBaseUrlForHost(deps.config, request.headers.host)).toString();
    return reply.type("text/html; charset=utf-8").send(renderMcp(shell(request, auth, "chatgpt"), { mcpUrl, clients: deps.oauthClients.listApprovedClients(auth.principal.ownerId), now: Date.now() }));
  });
  app.get("/dashboard/settings", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    return settingsPage(request, reply, auth);
  });
  app.get("/dashboard/settings/revoke-all", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const ctx = shell(request, auth, "settings");
    const count = ownedDevices(auth.principal.ownerId).filter(d => d.state !== "REVOKED").length;
    return reply.type("text/html; charset=utf-8").send(renderConfirm(ctx, { title: t(ctx.locale, "settings.revokeAll.confirm"), bullets: [t(ctx.locale, "settings.revokeAll.body", { count }), t(ctx.locale, "confirm.noFiles"), t(ctx.locale, "confirm.irreversible")], action: "/dashboard/devices/revoke-all", submitLabel: t(ctx.locale, "settings.revokeAll.title"), cancelHref: "/dashboard/settings", danger: true, confirmPhrase: t(ctx.locale, "settings.revokeAll.phrase") }));
  });
  app.get("/dashboard/clients/:clientId/revoke", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const { clientId } = request.params as { clientId: string };
    const client = deps.oauthClients.listApprovedClients(auth.principal.ownerId).find(c => c.clientId === clientId);
    if (!client) return dashboardError(request, reply, auth, 404, "notFound", "/dashboard/mcp");
    const ctx = shell(request, auth, "chatgpt"), who = displayClient(ctx, client);
    return reply.type("text/html; charset=utf-8").send(renderConfirm(ctx, { title: t(ctx.locale, "confirm.revokeClient", { name: who.name ?? who.host }), bullets: [t(ctx.locale, "confirm.clientHost", { host: who.host }), t(ctx.locale, "confirm.clientTokens"), t(ctx.locale, "confirm.clientAccount"), t(ctx.locale, "confirm.noFiles"), t(ctx.locale, "confirm.clientAgain")], action: "/dashboard/clients/" + encodeURIComponent(clientId) + "/revoke", submitLabel: t(ctx.locale, "client.revoke"), cancelHref: "/dashboard/mcp", danger: true }));
  });

  async function approveDashboardPairing(request: FastifyRequest, reply: FastifyReply) {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, null), bodyRecord(request).origin === "device" ? "/device" : "/dashboard/connect?step=3")) return;

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
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, "devices"), "/dashboard/devices/" + encodeURIComponent((request.params as { deviceId: string }).deviceId))) return;

    const { deviceId } = request.params as { deviceId: string };
    const name = bodyRecord(request).name;
    if (typeof name !== "string" || !name.trim()) {
      const device = ownedDevices(auth.principal.ownerId).find(d => d.id === deviceId);
      reply.code(400);
      return device ? detail(request, reply, auth, device, true) : dashboardError(request, reply, auth, 400, "invalid");
    }
    try {
      deps.devices.renameOwnedDevice(deviceId, auth.principal.ownerId, name);
      return redirect(reply, "/dashboard/devices/" + encodeURIComponent(deviceId), 303);
    } catch (error) {
      if (error instanceof DeviceNotFoundError) return dashboardError(request, reply, auth, 404, "notFound");
      throw error;
    }
  });

  app.post("/dashboard/devices/:deviceId/revoke", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, "devices"), "/dashboard/devices/" + encodeURIComponent((request.params as { deviceId: string }).deviceId))) return;

    const { deviceId } = request.params as { deviceId: string };
    try {
      deps.devices.revokeOwnedDevice(deviceId, auth.principal.ownerId);
      return redirect(reply, "/dashboard/devices/" + encodeURIComponent(deviceId), 303);
    } catch (error) {
      if (error instanceof DeviceNotFoundError) return dashboardError(request, reply, auth, 404, "notFound");
      throw error;
    }
  });

  app.post("/dashboard/devices/:deviceId/delete", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth) return;
    const { deviceId } = request.params as { deviceId: string };
    if (!requireCsrf(request, reply, auth, csrf, shell(request, auth, "devices"),
      "/dashboard/devices/" + encodeURIComponent(deviceId))) return;
    try {
      deps.deviceManagement.deleteOwnedDevice(deviceId, auth.principal.ownerId);
      return redirect(reply, "/dashboard/devices?deleted=1", 303);
    } catch (error) {
      if (error instanceof DeviceNotFoundError) return dashboardError(request, reply, auth, 404, "notFound");
      throw error;
    }
  });

  app.post("/dashboard/devices/revoke-all", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, "settings"), "/dashboard/settings")) return;
    deps.devices.revokeAllOwnedDevices(auth.principal.ownerId);
    return redirect(reply, "/dashboard/devices", 303);
  });

  app.post("/dashboard/clients/:clientId/revoke", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, "chatgpt"), "/dashboard/mcp")) return;
    const { clientId } = request.params as { clientId: string };
    if (!deps.oauthClients.revokeClient(clientId, auth.principal.ownerId)) {
      return dashboardError(request, reply, auth, 404, "notFound", "/dashboard/mcp");
    }
    return redirect(reply, "/dashboard/mcp", 303);
  });

  app.post("/dashboard/password", async (request, reply) => {
    const auth = requireDashboardAuth(request, reply, deps.sessions);
    if (!auth || !requireCsrf(request, reply, auth, csrf, shell(request, auth, "settings"), "/dashboard/settings")) return;

    const body = bodyRecord(request);
    if (
      typeof body.currentPassword !== "string" ||
      typeof body.newPassword !== "string" ||
      body.newPassword.length < 12
    ) {
      reply.code(400);
      return settingsPage(request, reply, auth, "invalid");
    }

    if (deps.owners.getOwner()?.id !== auth.principal.ownerId) return dashboardError(request, reply, auth, 403, "forbidden", "/dashboard/settings");
    const changed = await deps.owners.changePassword(
      auth.principal.ownerId,
      body.currentPassword,
      body.newPassword,
    );
    if (!changed) { reply.code(400); return settingsPage(request, reply, auth, "incorrect"); }

    deps.sessions.invalidateOtherSessions(
      auth.principal.ownerId,
      auth.sessionToken,
    );
    return redirect(reply, "/dashboard/settings?saved=password", 303);
  });
}
