import type { FastifyInstance } from "fastify";
import {
  InvalidDeviceCredentialError,
  type DeviceAuthService,
} from "../devices/device-auth.js";
import type { DeviceManagementService } from "../devices/device-management-service.js";
import {
  DeviceNotFoundError,
  type DeviceRepository,
} from "../devices/device-repository.js";
import {
  requireOwnerSession,
  type SessionRepository,
} from "../auth/session-repository.js";

function requireOwner(request: Parameters<typeof requireOwnerSession>[0], sessions: SessionRepository) {
  return requireOwnerSession(request, sessions);
}

export function registerDeviceRoutes(
  app: FastifyInstance,
  devices: DeviceRepository,
  deviceAuth: DeviceAuthService,
  sessions: SessionRepository,
  deviceManagement: DeviceManagementService,
): void {
  app.post("/api/device-auth/refresh", async (request, reply) => {
    const body = request.body as { refreshCredential?: unknown } | null;
    if (!body || typeof body.refreshCredential !== "string") {
      return reply.code(400).send({ error: "INVALID_REFRESH_CREDENTIAL" });
    }
    try {
      return reply.send(deviceAuth.refreshDeviceAccess(body.refreshCredential));
    } catch (error) {
      if (error instanceof InvalidDeviceCredentialError) {
        return reply.code(401).send({ error: "INVALID_DEVICE_CREDENTIAL" });
      }
      throw error;
    }
  });

  app.get("/api/devices", async (request, reply) => {
    const principal = requireOwner(request, sessions);
    if (!principal) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    return reply.send(devices.listOwnedDevices(principal.ownerId));
  });

  app.patch("/api/devices/:deviceId", async (request, reply) => {
    const principal = requireOwner(request, sessions);
    if (!principal) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    const params = request.params as { deviceId?: unknown };
    const body = request.body as { name?: unknown } | null;
    if (
      typeof params.deviceId !== "string" ||
      !body ||
      typeof body.name !== "string" ||
      !body.name.trim()
    ) {
      return reply.code(400).send({ error: "INVALID_DEVICE_UPDATE" });
    }
    try {
      return reply.send(devices.renameOwnedDevice(params.deviceId, principal.ownerId, body.name));
    } catch (error) {
      if (error instanceof DeviceNotFoundError) {
        return reply.code(404).send({ error: "DEVICE_NOT_FOUND" });
      }
      throw error;
    }
  });

  app.delete("/api/devices/:deviceId", async (request, reply) => {
    const owner = requireOwner(request, sessions);
    if (!owner) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const { deviceId } = request.params as { deviceId: string };
    try {
      deviceManagement.deleteOwnedDevice(deviceId, owner.ownerId);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof DeviceNotFoundError) return reply.code(404).send({ error: "DEVICE_NOT_FOUND" });
      throw error;
    }
  });

  app.post("/api/devices/revoke-all", async (request, reply) => {
    const principal = requireOwner(request, sessions);
    if (!principal) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    return reply.send({ revoked: devices.revokeAllOwnedDevices(principal.ownerId) });
  });

  app.post("/api/devices/:deviceId/revoke", async (request, reply) => {
    const principal = requireOwner(request, sessions);
    if (!principal) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    const params = request.params as { deviceId?: unknown };
    if (typeof params.deviceId !== "string") {
      return reply.code(400).send({ error: "INVALID_DEVICE_ID" });
    }
    try {
      return reply.send(devices.revokeOwnedDevice(params.deviceId, principal.ownerId));
    } catch (error) {
      if (error instanceof DeviceNotFoundError) {
        return reply.code(404).send({ error: "DEVICE_NOT_FOUND" });
      }
      throw error;
    }
  });
}
