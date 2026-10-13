import { describe, expect, it } from "vitest";
import type { Device } from "../devices/device-repository.js";
import { selectTargetDevice, DeviceRoutingError } from "./device-router.js";

const devices: Device[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Game PC",
    ownerId: "root-test",
    platform: "win32",
    agentVersion: "0.1.0",
    desktopCommanderVersion: "0.2.52",
    createdAt: 1,
    lastSeenAt: 10,
    revokedAt: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Dev Box",
    ownerId: "root-test",
    platform: "linux",
    agentVersion: "0.1.0",
    desktopCommanderVersion: "0.2.52",
    createdAt: 2,
    lastSeenAt: 11,
    revokedAt: null,
  },
];

function live(entries: Array<[string, string]>) {
  return entries.map(([deviceId, state]) => ({ deviceId, state })) as Array<{
    deviceId: string;
    state:
      | "OFFLINE"
      | "CONNECTED"
      | "AUTHENTICATED"
      | "EXECUTOR_STARTING"
      | "READY"
      | "REVOKED"
      | "INCOMPATIBLE"
      | "EXECUTOR_FAILED";
  }>;
}

describe("selectTargetDevice", () => {
  it("selects an explicitly requested READY device", () => {
    expect(
      selectTargetDevice(
        devices,
        live([
          [devices[0]!.id, "READY"],
          [devices[1]!.id, "READY"],
        ]),
        devices[1]!.id,
      ),
    ).toBe(devices[1]!.id);
  });

  it("rejects an explicitly requested device that is offline or not READY", () => {
    expect(() =>
      selectTargetDevice(devices, live([[devices[0]!.id, "CONNECTED"]]), devices[0]!.id),
    ).toThrow(DeviceRoutingError);

    try {
      selectTargetDevice(devices, live([]), devices[0]!.id);
    } catch (error) {
      expect(error).toMatchObject({ code: "DEVICE_OFFLINE" });
    }
  });

  it("auto-selects when exactly one device is READY", () => {
    expect(
      selectTargetDevice(
        devices,
        live([
          [devices[0]!.id, "READY"],
          [devices[1]!.id, "EXECUTOR_STARTING"],
        ]),
      ),
    ).toBe(devices[0]!.id);
  });

  it("requires explicit selection when multiple devices are READY", () => {
    try {
      selectTargetDevice(
        devices,
        live([
          [devices[0]!.id, "READY"],
          [devices[1]!.id, "READY"],
        ]),
      );
      throw new Error("expected routing error");
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceRoutingError);
      expect(error).toMatchObject({
        code: "DEVICE_NOT_READY",
        details: {
          reason: "MULTIPLE_READY_DEVICES",
          devices: [
            { id: devices[0]!.id, name: "Game PC" },
            { id: devices[1]!.id, name: "Dev Box" },
          ],
        },
      });
    }
  });

  it("rejects routing when no device is READY", () => {
    try {
      selectTargetDevice(
        devices,
        live([
          [devices[0]!.id, "CONNECTED"],
          [devices[1]!.id, "EXECUTOR_STARTING"],
        ]),
      );
      throw new Error("expected routing error");
    } catch (error) {
      expect(error).toMatchObject({
        code: "DEVICE_NOT_READY",
        details: { reason: "NO_READY_DEVICE" },
      });
    }
  });

  it("returns DEVICE_NOT_FOUND for an unknown explicit id", () => {
    try {
      selectTargetDevice(devices, live([]), "33333333-3333-4333-8333-333333333333");
      throw new Error("expected routing error");
    } catch (error) {
      expect(error).toMatchObject({ code: "DEVICE_NOT_FOUND" });
    }
  });
});
