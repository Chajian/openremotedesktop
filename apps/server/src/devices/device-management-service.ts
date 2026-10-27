import type { DeviceRepository } from "./device-repository.js";
import type { ConnectionRegistry } from "../relay/connection-registry.js";
import type { RequestBroker } from "../relay/request-broker.js";

/**
 * A single synchronous operation enforces the deletion boundary for both HTML
 * and API routes. The DB commit blocks all future authentication; detaching the
 * live connection blocks any further dispatch from the same event loop turn.
 */
export class DeviceManagementService {
  constructor(
    private readonly devices: Pick<DeviceRepository, "deleteOwnedDevice">,
    private readonly registry: Pick<ConnectionRegistry, "get" | "detach">,
    private readonly broker: Pick<RequestBroker, "handleDisconnect">,
  ) {}

  deleteOwnedDevice(deviceId: string, ownerId: string): boolean {
    const deleted = this.devices.deleteOwnedDevice(deviceId, ownerId);
    const connection = this.registry.get(deviceId);
    if (!connection) return deleted;
    // Dispatched operations become unknown unless a real result was recorded.
    this.broker.handleDisconnect(deviceId, connection.socket);
    this.registry.detach(deviceId, connection.socket);
    try {
      connection.socket.close(4003, "Device removed by owner");
    } catch {
      try { connection.socket.terminate(); } catch {
        // The DB is already revoked and the connection is detached.
      }
    }
    return deleted;
  }
}
