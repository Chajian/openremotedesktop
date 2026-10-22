import type { DeviceRepository } from "../devices/device-repository.js";
import type { OperationRecord } from "./operation-repository.js";

export type OperationActor = {
  userId: string;
  clientId: string;
  /** Revalidate token, resource audience, grant, expiry and revocation. */
  authorize(): Promise<boolean>;
};

export interface OperationAccessPolicy {
  allows(actor: OperationActor, deviceId: string, operation?: OperationRecord): Promise<boolean>;
}

export class OwnedOperationAccessPolicy implements OperationAccessPolicy {
  constructor(private readonly devices: Pick<DeviceRepository, "findById">) {}
  async allows(actor: OperationActor, deviceId: string, operation?: OperationRecord): Promise<boolean> {
    if (operation && (operation.requestedByUserId !== actor.userId || operation.originatingClientId !== actor.clientId)) return false;
    try { if (!await actor.authorize()) return false; } catch { return false; }
    // Read ownership after the async authorization check to avoid stale access.
    const device = this.devices.findById(deviceId);
    return Boolean(device && device.revokedAt === null && device.ownerId === actor.userId &&
      (!operation || device.ownerId === operation.deviceOwnerIdAtCreation));
  }
}
