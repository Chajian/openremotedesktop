import type { ProtocolErrorCode } from "@open-desktop-remote/protocol";
import type { Device } from "../devices/device-repository.js";
import type { LiveDeviceStatus } from "../relay/connection-registry.js";

export class DeviceRoutingError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DeviceRoutingError";
  }
}

export function selectTargetDevice(
  devices: readonly Device[],
  liveStatuses: readonly LiveDeviceStatus[],
  requestedDeviceId?: string,
): string {
  const byId = new Map(devices.map((device) => [device.id, device]));
  const liveById = new Map(liveStatuses.map((status) => [status.deviceId, status]));

  if (requestedDeviceId) {
    const device = byId.get(requestedDeviceId);
    if (!device) {
      throw new DeviceRoutingError(
        "DEVICE_NOT_FOUND",
        "Requested device was not found",
        { deviceId: requestedDeviceId },
      );
    }
    if (device.revokedAt !== null) {
      throw new DeviceRoutingError(
        "DEVICE_REVOKED",
        "Requested device has been revoked",
        { deviceId: requestedDeviceId },
      );
    }
    const live = liveById.get(requestedDeviceId);
    if (!live) {
      throw new DeviceRoutingError(
        "DEVICE_OFFLINE",
        "Requested device is offline",
        { deviceId: requestedDeviceId },
      );
    }
    if (live.state !== "READY") {
      throw new DeviceRoutingError(
        "DEVICE_NOT_READY",
        `Requested device is not READY (state: ${live.state})`,
        { deviceId: requestedDeviceId, state: live.state },
      );
    }
    return requestedDeviceId;
  }

  const ready = liveStatuses.filter(
    (status) =>
      status.state === "READY" &&
      byId.get(status.deviceId)?.revokedAt === null,
  );

  if (ready.length === 1) return ready[0]!.deviceId;

  if (ready.length === 0) {
    throw new DeviceRoutingError(
      "DEVICE_NOT_READY",
      "No device is READY",
      { reason: "NO_READY_DEVICE" },
    );
  }

  throw new DeviceRoutingError(
    "DEVICE_NOT_READY",
    "Multiple devices are READY; specify deviceId",
    {
      reason: "MULTIPLE_READY_DEVICES",
      devices: ready.map((status) => {
        const device = byId.get(status.deviceId)!;
        return { id: device.id, name: device.name };
      }),
    },
  );
}
