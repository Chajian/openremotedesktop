import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import type { OwnerRepository } from "../auth/owner-repository.js";
import type { SessionRepository } from "../auth/session-repository.js";

export function sessionCookie(
  token: string,
  ttlMs: number,
  config: ServerConfig,
): string {
  const parts = [
    `odr_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (config.environment === "production") parts.push("Secure");
  return parts.join("; ");
}

export function registerLoginRoutes(
  app: FastifyInstance,
  owners: OwnerRepository,
  sessions: SessionRepository,
  config: ServerConfig,
): void {
  app.post("/api/login", async (request, reply) => {
    const body = request.body as { password?: unknown } | null;
    if (!body || typeof body.password !== "string") {
      return reply.code(400).send({ error: "INVALID_PASSWORD" });
    }

    const owner = await owners.verifyOwnerPassword(body.password);
    if (!owner) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }

    const token = sessions.createOwnerSession(owner.id);
    reply.header("Set-Cookie", sessionCookie(token, sessions.ttlMs, config));
    return reply.code(204).send();
  });
}
