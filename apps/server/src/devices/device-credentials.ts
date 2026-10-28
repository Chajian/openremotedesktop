import { createHash, randomBytes, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Shared refresh-credential issuance and lookup for normal and support devices. */
export class DeviceCredentials {
  constructor(private readonly db: BetterSqlite3.Database) {}

  hasIssued(deviceId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM device_credentials WHERE device_id = ?",
    ).get(deviceId));
  }

  /** Caller owns the containing transaction when issuing alongside a device. */
  issue(deviceId: string, createdAt = Date.now()): string {
    const value = randomBytes(32).toString("base64url");
    this.db.prepare(
      `INSERT INTO device_credentials
       (id, device_id, refresh_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ).run(randomUUID(), deviceId, hash(value), createdAt);
    return value;
  }

  /** An active credential cannot authenticate a revoked or deleted device. */
  activeDeviceId(value: string): string | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const row = this.db.prepare(
      `SELECT dc.device_id AS deviceId FROM device_credentials dc
       JOIN devices d ON d.id = dc.device_id
       WHERE dc.refresh_hash = ? AND dc.revoked_at IS NULL
         AND d.revoked_at IS NULL AND d.deleted_at IS NULL`,
    ).get(hash(value)) as {deviceId:string}|undefined;
    return row?.deviceId ?? null;
  }

  /**
   * Prove possession of a credential that was issued, even after revocation.
   * This NEVER authorizes tool access; only the support-ended status endpoint
   * may use it to identify the terminated session.
   */
  issuedDeviceId(value: string): string | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const row = this.db.prepare(
      "SELECT device_id AS deviceId FROM device_credentials WHERE refresh_hash = ?",
    ).get(hash(value)) as {deviceId:string}|undefined;
    return row?.deviceId ?? null;
  }
}
