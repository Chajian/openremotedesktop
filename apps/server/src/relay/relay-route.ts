import {
  parseRelayMessage,
  type RelayMessage,
} from "@open-desktop-remote/protocol";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  InvalidDeviceAccessTokenError,
  type DeviceAuthService,
  type DevicePrincipal,
} from "../devices/device-auth.js";
import type { DeviceRepository } from "../devices/device-repository.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { HEARTBEAT_INTERVAL_MS } from "./heartbeat.js";
import { RequestBroker } from "./request-broker.js";

const registries = new WeakMap<FastifyInstance, ConnectionRegistry>();
const brokers = new WeakMap<FastifyInstance, RequestBroker>();

export class RelayAuthenticationError extends Error {
  constructor(message = "Invalid device access token") {
    super(message);
    this.name = "RelayAuthenticationError";
  }
}

export class RelayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayProtocolError";
  }
}

export function relayRegistryFor(app: FastifyInstance): ConnectionRegistry {
  const registry = registries.get(app);
  if (!registry) throw new Error("Relay route has not been registered");
  return registry;
}

export function relayRequestBrokerFor(app: FastifyInstance): RequestBroker {
  const broker = brokers.get(app);
  if (!broker) throw new Error("Relay route has not been registered");
  return broker;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function authenticateRelayToken(
  deviceAuth: DeviceAuthService,
  accessToken: string | undefined,
): DevicePrincipal {
  if (!accessToken) {
    throw new RelayAuthenticationError("Missing device access token");
  }
  try {
    return deviceAuth.verifyDeviceAccess(accessToken);
  } catch (error) {
    if (error instanceof InvalidDeviceAccessTokenError) {
      throw new RelayAuthenticationError();
    }
    throw error;
  }
}

function assertMessageDevice(message: RelayMessage, deviceId: string): void {
  if (
    "deviceId" in message &&
    message.deviceId !== undefined &&
    message.deviceId !== deviceId
  ) {
    throw new RelayProtocolError("Device id does not match access token");
  }
}

export function handleRelayPayload(
  registry: ConnectionRegistry,
  devices: DeviceRepository,
  deviceId: string,
  socket: WebSocket,
  raw: string,
  broker?: Pick<RequestBroker, "handleMessage">,
): RelayMessage {
  const message = parseRelayMessage(JSON.parse(raw));
  assertMessageDevice(message, deviceId);

  switch (message.type) {
    case "agent.hello":
      devices.updateRuntimeMetadata(deviceId, {
        platform: message.platform,
        agentVersion: message.agentVersion,
        desktopCommanderVersion: message.desktopCommanderVersion,
      });
      registry.heartbeat(deviceId, socket);
      break;
    case "agent.executor_status":
      registry.markExecutorState(deviceId, socket, message.state);
      devices.touchLastSeen(deviceId);
      break;
    case "agent.ready":
      registry.markExecutorState(deviceId, socket, "READY");
      devices.updateRuntimeMetadata(deviceId, {
        desktopCommanderVersion: message.desktopCommanderVersion,
      });
      registry.heartbeat(deviceId, socket);
      break;
    case "heartbeat":
      registry.heartbeat(deviceId, socket);
      devices.touchLastSeen(deviceId);
      break;
    case "tool.result":
    case "tool.error":
      broker?.handleMessage(message);
      break;
    case "tool.call":
    case "tool.cancel":
    case "server.notice":
      throw new RelayProtocolError(
        "Message direction is invalid for an agent",
      );
  }

  return message;
}

export function registerRelayRoute(
  app: FastifyInstance,
  deviceAuth: DeviceAuthService,
  devices: DeviceRepository,
  registry = new ConnectionRegistry(),
  broker = new RequestBroker(registry),
): void {
  registries.set(app, registry);
  brokers.set(app, broker);

  const sweepTimer = setInterval(
    () => registry.sweepStale(),
    HEARTBEAT_INTERVAL_MS,
  );
  sweepTimer.unref();
  app.addHook("onClose", async () => clearInterval(sweepTimer));

  app.get("/relay", { websocket: true }, (socket, request) => {
    let principal: DevicePrincipal;
    try {
      principal = authenticateRelayToken(
        deviceAuth,
        bearerToken(request.headers.authorization) ?? undefined,
      );
    } catch {
      socket.close(4401, "Invalid device access token");
      return;
    }

    const { deviceId } = principal;
    registry.attach(deviceId, socket);
    registry.markAuthenticated(deviceId, socket);

    socket.on("message", (raw) => {
      try {
        handleRelayPayload(
          registry,
          devices,
          deviceId,
          socket,
          raw.toString(),
          broker,
        );
      } catch (error) {
        const reason =
          error instanceof RelayProtocolError
            ? error.message
            : "Malformed relay message";
        socket.close(4400, reason);
      }
    });

    socket.on("close", () => {
      broker.handleDisconnect(deviceId, socket as WebSocket);
      registry.detach(deviceId, socket as WebSocket);
    });
  });
}
