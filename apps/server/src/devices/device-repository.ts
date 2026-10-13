import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

export type Device = {
  id: string;
  name: string;
  ownerId: string | null;
  platform: string | null;
  agentVersion: string | null;
  desktopCommanderVersion: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
};

type DeviceRow = {
  id: string;
  name: string;
  owner_id: string | null;
  platform: string | null;
  agent_version: string | null;
  desktop_commander_version: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
};

function mapDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    platform: row.platform,
    agentVersion: row.agent_version,
    desktopCommanderVersion: row.desktop_commander_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export class DeviceNotFoundError extends Error {
  constructor(public readonly deviceId: string) {
    super(`Device not found: ${deviceId}`);
    this.name = "DeviceNotFoundError";
  }
}

export class DeviceRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(name: string, ownerId: string): Device {
    const device: Device = {
      id: randomUUID(),
      name,
      ownerId,
      platform: null,
      agentVersion: null,
      desktopCommanderVersion: null,
      createdAt: Date.now(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO devices (id, name, owner_id, platform, agent_version, desktop_commander_version, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)",
      )
      .run(device.id, device.name, device.ownerId, device.createdAt);
    return device;
  }

  findById(deviceId: string): Device | null {
    const row = this.db
      .prepare(
        "SELECT id, name, owner_id, platform, agent_version, desktop_commander_version, created_at, last_seen_at, revoked_at FROM devices WHERE id = ?",
      )
      .get(deviceId) as DeviceRow | undefined;
    return row ? mapDevice(row) : null;
  }

  listDevices(): Device[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, owner_id, platform, agent_version, desktop_commander_version, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at, id",
      )
      .all() as DeviceRow[];
    return rows.map(mapDevice);
  }

  updateRuntimeMetadata(
    deviceId: string,
    metadata: {
      platform?: string;
      agentVersion?: string;
      desktopCommanderVersion?: string;
    },
    at = Date.now(),
  ): Device {
    const existing = this.findById(deviceId);
    if (!existing) throw new DeviceNotFoundError(deviceId);
    if (existing.revokedAt !== null) return existing;

    this.db
      .prepare(
        `UPDATE devices
         SET platform = COALESCE(?, platform),
             agent_version = COALESCE(?, agent_version),
             desktop_commander_version = COALESCE(?, desktop_commander_version),
             last_seen_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(
        metadata.platform ?? null,
        metadata.agentVersion ?? null,
        metadata.desktopCommanderVersion ?? null,
        at,
        deviceId,
      );
    return this.findById(deviceId)!;
  }

  touchLastSeen(deviceId: string, at = Date.now()): Device {
    const existing = this.findById(deviceId);
    if (!existing) throw new DeviceNotFoundError(deviceId);
    if (existing.revokedAt !== null) return existing;

    this.db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(at, deviceId);
    return this.findById(deviceId)!;
  }

  renameDevice(deviceId: string, name: string): Device {
    const normalized = name.trim();
    if (!normalized) throw new TypeError("Device name must not be empty");
    const result = this.db
      .prepare("UPDATE devices SET name = ? WHERE id = ?")
      .run(normalized, deviceId);
    if (result.changes !== 1) throw new DeviceNotFoundError(deviceId);
    return this.findById(deviceId)!;
  }

  revokeDevice(deviceId: string): Device {
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = this.findById(deviceId);
      if (!existing) throw new DeviceNotFoundError(deviceId);
      const revokedAt = existing.revokedAt ?? now;
      this.db
        .prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .run(revokedAt, deviceId);
      this.db
        .prepare(
          "UPDATE device_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?",
        )
        .run(revokedAt, deviceId);
      this.db
        .prepare(
          "UPDATE device_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?",
        )
        .run(revokedAt, deviceId);
      return this.findById(deviceId)!;
    })();
  }

  revokeAllDevices(): number {
    const now = Date.now();
    return this.db.transaction(() => {
      const result = this.db
        .prepare("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?)")
        .run(now);
      this.db
        .prepare(
          "UPDATE device_credentials SET revoked_at = COALESCE(revoked_at, ?)",
        )
        .run(now);
      this.db
        .prepare(
          "UPDATE device_access_tokens SET revoked_at = COALESCE(revoked_at, ?)",
        )
        .run(now);
      return result.changes;
    })();
  }

  listOwnedDevices(ownerId: string): Device[] {
    const rows = this.db.prepare(
      "SELECT id, name, owner_id, platform, agent_version, desktop_commander_version, created_at, last_seen_at, revoked_at FROM devices WHERE owner_id = ? ORDER BY created_at, id"
    ).all(ownerId) as DeviceRow[];
    return rows.map(mapDevice);
  }

  private requireOwnedDevice(deviceId: string, ownerId: string): Device {
    const device = this.findById(deviceId);
    if (!device || device.ownerId !== ownerId) throw new DeviceNotFoundError(deviceId);
    return device;
  }

  renameOwnedDevice(deviceId: string, ownerId: string, name: string): Device {
    this.requireOwnedDevice(deviceId, ownerId);
    return this.renameDevice(deviceId, name);
  }

  revokeOwnedDevice(deviceId: string, ownerId: string): Device {
    this.requireOwnedDevice(deviceId, ownerId);
    return this.revokeDevice(deviceId);
  }

  revokeAllOwnedDevices(ownerId: string): number {
    return this.db.transaction(() => {
      const ids = this.db.prepare("SELECT id FROM devices WHERE owner_id = ?")
        .all(ownerId) as Array<{id: string}>;
      for (const {id} of ids) this.revokeDevice(id);
      return ids.length;
    })();
  }

}
