import { createHash, randomBytes, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type { DeviceRepository } from "../devices/device-repository.js";
import { DeviceCredentials } from "../devices/device-credentials.js";
import type { DeviceManagementService } from "../devices/device-management-service.js";

const INVITE_TTL_MS = 5 * 60_000;
// Shared joined-and-not-ended predicate for both public navigation queries.
const ACTIVE_JOINED_SUPPORT = `FROM support_sessions s
  JOIN devices d ON d.id = s.device_id
  WHERE s.owner_id = ? AND s.ended_at IS NULL
    AND s.device_id IS NOT NULL AND d.deleted_at IS NULL`;
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const validInvite = (value: string) => /^[A-Za-z0-9_-]{32}$/.test(value);
export class SupportNotFoundError extends Error {}
export class SupportInviteExpiredError extends Error {}
export class SupportAlreadyJoinedError extends Error {}

type SessionRow = {
  id: string; owner_id: string; label: string; created_at: number;
  invite_expires_at: number; joined_at: number | null; device_id: string | null;
  ended_at: number | null; ended_reason: string | null;
  deleted_at?: number | null; linked_device_id?: string | null;
};
export type SupportSession = {
  id: string; label: string; createdAt: number; inviteExpiresAt: number;
  joinedAt: number | null; deviceId: string | null; endedAt: number | null;
  endedReason: string | null; state: "inviting" | "expired" | "active" | "ended";
  deviceAccessible: boolean;
};

export class SupportService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly devices: DeviceRepository,
    private readonly management: DeviceManagementService,
    private readonly now: () => number = Date.now,
    private readonly credentials: DeviceCredentials = new DeviceCredentials(db),
  ) {}

  private mapped(row: SessionRow): SupportSession {
    const state = row.ended_at !== null || row.deleted_at != null ? "ended"
      : row.device_id !== null ? "active"
      : row.invite_expires_at <= this.now() ? "expired" : "inviting";
    return {
      id: row.id, label: row.label, createdAt: row.created_at,
      inviteExpiresAt: row.invite_expires_at, joinedAt: row.joined_at,
      deviceId: row.device_id, endedAt: row.ended_at,
      deviceAccessible: row.device_id !== null && row.linked_device_id != null &&
        row.deleted_at == null && row.ended_at === null,
      endedReason: row.ended_reason ?? (row.deleted_at != null ? "device_removed" : null),
      state,
    };
  }

  create(ownerId: string, label: string): { session: SupportSession; invite: string } {
    const safe = label.trim().slice(0, 80) || "Customer support";
    const createdAt = this.now();
    const invite = randomBytes(24).toString("base64url");
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO support_sessions
       (id, owner_id, label, invite_hash, created_at, invite_expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, ownerId, safe, hash(invite), createdAt, createdAt + INVITE_TTL_MS);
    return {
      invite,
      session: this.mapped({
        id, owner_id: ownerId, label: safe, created_at: createdAt,
        invite_expires_at: createdAt + INVITE_TTL_MS, joined_at: null,
        device_id: null, ended_at: null, ended_reason: null,
      }),
    };
  }

  private byInvite(invite: string): SessionRow {
    if (!validInvite(invite)) throw new SupportNotFoundError();
    const row = this.db.prepare(
      "SELECT * FROM support_sessions WHERE invite_hash = ?",
    ).get(hash(invite)) as SessionRow | undefined;
    if (!row || row.ended_at !== null) throw new SupportNotFoundError();
    if (row.device_id !== null) throw new SupportAlreadyJoinedError();
    if (row.invite_expires_at <= this.now()) throw new SupportInviteExpiredError();
    return row;
  }
  preview(invite: string): { label: string; inviteExpiresAt: number; access: "full" } {
    const row = this.byInvite(invite);
    return { label: row.label, inviteExpiresAt: row.invite_expires_at, access: "full" };
  }

  join(invite: string, deviceName: string, platform: string): {
    deviceId: string; refreshCredential: string; sessionId: string;
  } {
    if (platform !== "win32") throw new TypeError("Windows only in first release");
    return this.db.transaction(() => {
      const row = this.byInvite(invite);
      const name = deviceName.trim().slice(0, 80) || "Customer Windows";
      const device = this.devices.create(name, row.owner_id);
      const at = this.now();
      const refreshCredential = this.credentials.issue(device.id, at);
      const result = this.db.prepare(`UPDATE support_sessions
        SET device_id = ?, joined_at = ? WHERE id = ?
        AND device_id IS NULL AND ended_at IS NULL AND invite_expires_at > ?`
      ).run(device.id, at, row.id, at);
      if (result.changes !== 1) throw new SupportAlreadyJoinedError();
      return { deviceId: device.id, refreshCredential, sessionId: row.id };
    })();
  }

  listOwned(ownerId: string): SupportSession[] {
    const rows = this.db.prepare(
      `SELECT s.*, d.deleted_at, d.id AS linked_device_id FROM support_sessions s
       LEFT JOIN devices d ON d.id = s.device_id
       WHERE s.owner_id = ? ORDER BY s.created_at DESC, s.id DESC`,
    ).all(ownerId) as SessionRow[];
    return rows.map(row => this.mapped(row));
  }
  /** Existence and ID-only queries do not hydrate the owner's history. */
  hasActiveSupport(ownerId: string): boolean {
    return Boolean(this.db.prepare(
      `SELECT 1 ${ACTIVE_JOINED_SUPPORT} LIMIT 1`,
    ).get(ownerId));
  }

  activeDeviceIds(ownerId: string): string[] {
    const rows = this.db.prepare(
      `SELECT s.device_id AS deviceId ${ACTIVE_JOINED_SUPPORT}`,
    ).all(ownerId) as Array<{deviceId:string}>;
    return rows.map(row => row.deviceId);
  }

  private end(row: SessionRow, reason: "owner" | "customer"): boolean {
    if (row.ended_at !== null) return false;
    // Revocation and disconnect must complete before declaring the session ended.
    if (row.device_id) this.management.deleteOwnedDevice(row.device_id, row.owner_id);
    this.db.prepare(
      "UPDATE support_sessions SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL",
    ).run(this.now(), reason, row.id);
    return true;
  }

  endOwned(sessionId: string, ownerId: string): boolean {
    const row = this.db.prepare(
      "SELECT * FROM support_sessions WHERE id = ? AND owner_id = ?",
    ).get(sessionId, ownerId) as SessionRow | undefined;
    if (!row) throw new SupportNotFoundError();
    return this.end(row, "owner");
  }

  stopByCredential(refreshCredential: string): boolean {
    const deviceId = this.credentials.activeDeviceId(refreshCredential);
    if (!deviceId) throw new SupportNotFoundError();
    const row = this.db.prepare(
      "SELECT * FROM support_sessions WHERE device_id = ? AND ended_at IS NULL",
    ).get(deviceId) as SessionRow | undefined;
    if (!row) throw new SupportNotFoundError();
    return this.end(row, "customer");
  }

  /** Credential possession proves this session's outcome, never tool authority. */
  statusByCredential(refreshCredential: string): {state: "active" | "ended"; reason?: "owner" | "customer"} {
    const deviceId = this.credentials.issuedDeviceId(refreshCredential);
    if (!deviceId) throw new SupportNotFoundError();
    const row = this.db.prepare(
      "SELECT ended_at AS endedAt, ended_reason AS reason FROM support_sessions WHERE device_id = ?",
    ).get(deviceId) as {endedAt:number|null;reason:"owner"|"customer"|null}|undefined;
    if (!row) throw new SupportNotFoundError();
    if (row.endedAt === null) return {state:"active"};
    if (row.reason !== "owner" && row.reason !== "customer") throw new SupportNotFoundError();
    return {state:"ended",reason:row.reason};
  }
}
