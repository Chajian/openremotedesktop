import type { FastifyInstance } from "fastify";
import type { SessionRepository } from "../auth/session-repository.js";
import { requireOwnerSession } from "../auth/session-repository.js";
import { publicBaseUrlForHost, type ServerConfig } from "../config.js";
import {
  PairingAlreadyApprovedError,
  PairingExpiredError,
  PairingNotFoundError,
  type PairingService,
} from "../devices/pairing-service.js";

export function registerDevicePairingRoutes(
  app: FastifyInstance,
  pairings: PairingService,
  sessions: SessionRepository,
  config: ServerConfig,
): void {
  app.post("/api/device-pairings", async (request, reply) => {
    return reply.code(201).send({
      ...pairings.createPairing(),
      verificationUri: new URL("/device", publicBaseUrlForHost(config, request.headers.host)).toString(),
    });
  });

  app.get("/api/device-pairings/poll", async (request, reply) => {
    const query = request.query as { device_code?: unknown };
    if (typeof query.device_code !== "string" || !query.device_code) {
      return reply.code(400).send({ error: "INVALID_DEVICE_CODE" });
    }
    return reply.send(pairings.pollPairing(query.device_code));
  });

  app.post("/api/device-pairings/:userCode/approve", async (request, reply) => {
    const principal = requireOwnerSession(request, sessions);
    if (!principal) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }

    const params = request.params as { userCode?: unknown };
    const body = request.body as { friendlyName?: unknown } | null;
    if (typeof params.userCode !== "string") {
      return reply.code(400).send({ error: "INVALID_USER_CODE" });
    }
    const friendlyName =
      typeof body?.friendlyName === "string" ? body.friendlyName : undefined;

    try {
      const device = pairings.approvePairing(params.userCode, friendlyName ?? "Unnamed Device", principal.ownerId);
      return reply.send({ deviceId: device.id, name: device.name });
    } catch (error) {
      if (error instanceof PairingNotFoundError) {
        return reply.code(404).send({ error: "PAIRING_NOT_FOUND" });
      }
      if (error instanceof PairingExpiredError) {
        return reply.code(410).send({ error: "PAIRING_EXPIRED" });
      }
      if (error instanceof PairingAlreadyApprovedError) {
        return reply.code(409).send({ error: "PAIRING_ALREADY_APPROVED" });
      }
      throw error;
    }
  });
}
