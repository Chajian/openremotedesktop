import { createHash, randomBytes, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type { DeviceRepository } from "./device-repository.js";

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

export type DeviceAccessToken = {
  accessToken: string;
  expiresAt: number;
  deviceId: string;
};

export type DevicePrincipal = { deviceId: string };

export class InvalidDeviceCredentialError extends Error {
  constructor() {
    super("Invalid or revoked device credential");
    this.name = "InvalidDeviceCredentialError";
  }
}

export class InvalidDeviceAccessTokenError extends Error {
  constructor() {
    super("Invalid, expired, or revoked device access token");
    this.name = "InvalidDeviceAccessTokenError";
  }
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class DeviceAuthService {
  private readonly now: () => number;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly devices: DeviceRepository,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  refreshDeviceAccess(refreshCredential: string): DeviceAccessToken {
    const row = this.db
      .prepare(
        `SELECT dc.device_id AS deviceId
         FROM device_credentials dc
         JOIN devices d ON d.id = dc.device_id
         WHERE dc.refresh_hash = ?
           AND dc.revoked_at IS NULL
           AND d.revoked_at IS NULL`,
      )
      .get(hashSecret(refreshCredential)) as { deviceId: string } | undefined;

    if (!row || !this.devices.findById(row.deviceId)) {
      throw new InvalidDeviceCredentialError();
    }

    const accessToken = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + ACCESS_TOKEN_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO device_access_tokens
          (id, device_id, token_hash, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        randomUUID(),
        row.deviceId,
        hashSecret(accessToken),
        createdAt,
        expiresAt,
      );

    return { accessToken, expiresAt, deviceId: row.deviceId };
  }

  verifyDeviceAccess(accessToken: string): DevicePrincipal {
    const now = this.now();
    const row = this.db
      .prepare(
        `SELECT dat.device_id AS deviceId
         FROM device_access_tokens dat
         JOIN devices d ON d.id = dat.device_id
         WHERE dat.token_hash = ?
           AND dat.revoked_at IS NULL
           AND dat.expires_at > ?
           AND d.revoked_at IS NULL`,
      )
      .get(hashSecret(accessToken), now) as { deviceId: string } | undefined;

    if (!row) throw new InvalidDeviceAccessTokenError();
    return { deviceId: row.deviceId };
  }
}
