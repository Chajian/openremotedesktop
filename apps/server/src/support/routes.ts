import type { FastifyInstance } from "fastify";
import { renderCustomerSupport } from "../dashboard/views/support.js";
import { installerInstructions, downloadSourceFromQuery } from "../dashboard/installer.js";
import { localeFromRequest } from "../dashboard/ui/i18n.js";
import { publicBaseUrlForHost, type ServerConfig } from "../config.js";
import { SupportService, SupportNotFoundError,
  SupportInviteExpiredError, SupportAlreadyJoinedError } from "./support-service.js";
import { supportDownloadUrl, supportLauncher, supportsDownloadedLauncher } from "./support-launcher.js";

function errorReply(reply: {code(n: number): {send(data: unknown): unknown}}, error: unknown) {
  if (error instanceof SupportNotFoundError) return reply.code(404).send({error:"SUPPORT_NOT_FOUND"});
  if (error instanceof SupportInviteExpiredError) return reply.code(410).send({error:"INVITE_EXPIRED"});
  if (error instanceof SupportAlreadyJoinedError) return reply.code(409).send({error:"INVITE_ALREADY_USED"});
  throw error;
}

export function registerSupportRoutes(app: FastifyInstance, support: SupportService, config: ServerConfig): void {
  app.get("/support/invite/:invite/windows.cmd", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    if (!config.supportEnabled || !config.agentInstallEnabled || !supportsDownloadedLauncher(config.supportAgentVersion)) {
      return reply.code(404).send();
    }
    const {invite} = request.params as {invite: string};
    try {
      support.preview(invite);
      const origin = publicBaseUrlForHost(config, request.headers.host);
      const source = downloadSourceFromQuery((request.query as {downloadSource?: unknown}).downloadSource);
      const file = supportLauncher(origin, invite, config.supportAgentVersion!, source);
      return reply.header("Content-Disposition", 'attachment; filename="OpenRemote-Support.cmd"')
        .type("application/octet-stream").send(file);
    } catch (error) { return errorReply(reply, error); }
  });
  app.get("/support/invite/:invite", async (request, reply) => {
    if (!config.supportEnabled) return reply.code(404).send();
    reply.header("Cache-Control","no-store").header("Referrer-Policy","no-referrer");
    reply.header("X-Frame-Options","DENY").header("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const {invite} = request.params as {invite:string};
    try {
      const preview = support.preview(invite);
      const baseUrl = publicBaseUrlForHost(config, request.headers.host);
      const downloadSource = downloadSourceFromQuery((request.query as {downloadSource?: unknown}).downloadSource);
      const install = config.agentInstallEnabled && config.supportAgentVersion
        ? installerInstructions("win", baseUrl, {invite, version:config.supportAgentVersion}, downloadSource).command
        : undefined;
      return reply.type("text/html; charset=utf-8").send(renderCustomerSupport(
        localeFromRequest(request), baseUrl, invite,
        preview.label, preview.inviteExpiresAt, install, downloadSource,
        install && supportsDownloadedLauncher(config.supportAgentVersion)
          ? supportDownloadUrl(baseUrl, invite, downloadSource) : undefined));
    } catch (error) { return errorReply(reply, error); }
  });

  app.get("/api/support/invite/:invite", async (request, reply) => {
    if (!config.supportEnabled) return reply.code(404).send();
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    const { invite } = request.params as { invite: string };
    try { return reply.send(support.preview(invite)); }
    catch (error) { return errorReply(reply, error); }
  });
  app.post("/api/support/join", async (request, reply) => {
    if (!config.supportEnabled) return reply.code(404).send();
    reply.header("Cache-Control", "no-store");
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.invite !== "string" || typeof body.deviceName !== "string" ||
      typeof body.platform !== "string" || body.deviceName.length > 80) {
      return reply.code(400).send({error:"INVALID_SUPPORT_REQUEST"});
    }
    try {
      const credential = support.join(body.invite, body.deviceName, body.platform);
      return reply.code(201).send(credential);
    } catch (error) {
      if (error instanceof TypeError) return reply.code(400).send({error:"UNSUPPORTED_PLATFORM"});
      return errorReply(reply, error);
    }
  });
  // This read verifies possession of the originally issued refresh secret;
  // it grants no device authority and remains available after revocation.
  app.post("/api/support/status", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.refreshCredential !== "string") {
      return reply.code(400).send({error:"INVALID_SUPPORT_REQUEST"});
    }
    try { return reply.send(support.statusByCredential(body.refreshCredential)); }
    catch (error) { return errorReply(reply, error); }
  });

  app.post("/api/support/stop", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body.refreshCredential !== "string") {
      return reply.code(400).send({error:"INVALID_SUPPORT_REQUEST"});
    }
    try {
      support.stopByCredential(body.refreshCredential);
      return reply.code(204).send();
    } catch (error) { return errorReply(reply, error); }
  });
}
