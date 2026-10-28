import { createHash, randomBytes } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import { type Device, DeviceRepository } from "./device-repository.js";
import { DeviceCredentials } from "./device-credentials.js";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type PairingRow = {
  user_code: string;
  requested_at: number;
  expires_at: number;
  approved_at: number | null;
  device_id: string | null;
};

export type PendingPairing = {
  userCode: string;
  requestedAt: number;
  expiresAt: number;
};

export type PairingPollResult =
  | { status: "pending"; interval: number }
  | { status: "expired" }
  | { status: "approved"; deviceId: string; refreshCredential: string }
  | { status: "credential_already_issued"; deviceId: string }
  | { status: "invalid" };

export class PairingNotFoundError extends Error {
  constructor() {
    super("Pairing code not found");
    this.name = "PairingNotFoundError";
  }
}

export class PairingExpiredError extends Error {
  constructor() {
    super("Pairing code expired");
    this.name = "PairingExpiredError";
  }
}

export class PairingAlreadyApprovedError extends Error {
  constructor() {
    super("Pairing code already approved");
    this.name = "PairingAlreadyApprovedError";
  }
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomUserCode(): string {
  const bytes = randomBytes(8);
  let value = "";
  for (let index = 0; index < 8; index += 1) {
    value += USER_CODE_ALPHABET[bytes[index]! % USER_CODE_ALPHABET.length];
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export class PairingService {
  private readonly now: () => number;
  private readonly credentials: DeviceCredentials;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly devices: DeviceRepository,
    private readonly publicBaseUrl: URL,
    options: { now?: () => number; credentials?: DeviceCredentials } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.credentials = options.credentials ?? new DeviceCredentials(db);
  }

  createPairing(): {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  } {
    const deviceCode = randomBytes(32).toString("base64url");
    const requestedAt = this.now();
    let userCode = randomUserCode();
    while (
      this.db
        .prepare("SELECT 1 FROM device_pairings WHERE user_code = ?")
        .get(userCode)
    ) {
      userCode = randomUserCode();
    }

    this.db
      .prepare(
        `INSERT INTO device_pairings
          (device_code_hash, user_code, requested_at, expires_at, approved_at, device_id)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        hashSecret(deviceCode),
        userCode,
        requestedAt,
        requestedAt + PAIRING_TTL_MS,
      );

    return {
      deviceCode,
      userCode,
      verificationUri: new URL("/device", this.publicBaseUrl).toString(),
      expiresIn: PAIRING_TTL_MS / 1000,
      interval: POLL_INTERVAL_SECONDS,
    };
  }

  listPendingPairings(): PendingPairing[] {
    const rows = this.db
      .prepare(
        `SELECT user_code, requested_at, expires_at
         FROM device_pairings
         WHERE approved_at IS NULL AND device_id IS NULL AND expires_at > ?
         ORDER BY requested_at, user_code`,
      )
      .all(this.now()) as Array<{
        user_code: string;
        requested_at: number;
        expires_at: number;
      }>;

    return rows.map((row) => ({
      userCode: row.user_code,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
    }));
  }

  approvePairing(userCode: string, friendlyName: string, ownerId: string): Device {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT user_code, requested_at, expires_at, approved_at, device_id
           FROM device_pairings WHERE user_code = ?`,
        )
        .get(userCode) as PairingRow | undefined;

      if (!row) throw new PairingNotFoundError();
      if (row.expires_at <= this.now()) throw new PairingExpiredError();
      if (row.approved_at !== null || row.device_id !== null) {
        throw new PairingAlreadyApprovedError();
      }

      const device = this.devices.create(friendlyName.trim() || "Unnamed Device", ownerId);
      this.db
        .prepare(
          "UPDATE device_pairings SET approved_at = ?, device_id = ? WHERE user_code = ?",
        )
        .run(this.now(), device.id, userCode);
      return device;
    })();
  }

  pollPairing(deviceCode: string): PairingPollResult {
    const row = this.db
      .prepare(
        `SELECT user_code, requested_at, expires_at, approved_at, device_id
         FROM device_pairings WHERE device_code_hash = ?`,
      )
      .get(hashSecret(deviceCode)) as PairingRow | undefined;

    if (!row) return { status: "invalid" };
    if (row.expires_at <= this.now()) return { status: "expired" };
    if (row.approved_at === null || row.device_id === null) {
      return { status: "pending", interval: POLL_INTERVAL_SECONDS };
    }

    if (this.credentials.hasIssued(row.device_id)) {
      return { status: "credential_already_issued", deviceId: row.device_id };
    }

    const refreshCredential = this.credentials.issue(row.device_id, this.now());

    return {
      status: "approved",
      deviceId: row.device_id,
      refreshCredential,
    };
  }
}
