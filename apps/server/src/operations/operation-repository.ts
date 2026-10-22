import type BetterSqlite3 from "better-sqlite3";

export type OperationOutcome = "success" | "error" | "unknown";
export type OperationRecord = {
  operationId: string;
  requestedByUserId: string;
  originatingClientId: string;
  deviceId: string;
  deviceOwnerIdAtCreation: string;
  toolName: string;
  bootId: string | null;
  phase: "dispatched" | "unknown" | "completed";
  outcome: OperationOutcome | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  retentionUntil: number;
  completedAt: number | null;
  terminalDigest: string | null;
  conflict: boolean;
  cancelRequested: boolean;
};
const SELECT = `SELECT operation_id AS operationId, requested_by_user_id AS requestedByUserId,
 originating_client_id AS originatingClientId, device_id AS deviceId,
 device_owner_id_at_creation AS deviceOwnerIdAtCreation, tool_name AS toolName,
 boot_id AS bootId, phase, outcome, created_at AS createdAt, updated_at AS updatedAt,
 expires_at AS expiresAt, retention_until AS retentionUntil, completed_at AS completedAt,
 terminal_digest AS terminalDigest, conflict, cancel_requested AS cancelRequested FROM operations`;

/** Metadata only: no arguments, bodies, or human-readable error text enter SQL. */
export class OperationRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(record: Pick<OperationRecord, "operationId" | "requestedByUserId" | "originatingClientId" | "deviceId" | "deviceOwnerIdAtCreation" | "toolName" | "bootId" | "createdAt" | "expiresAt">): OperationRecord {
    this.db.prepare(`INSERT INTO operations (operation_id, requested_by_user_id, originating_client_id,
      device_id, device_owner_id_at_creation, tool_name, boot_id, phase, created_at, updated_at, expires_at, retention_until)
      VALUES (@operationId, @requestedByUserId, @originatingClientId, @deviceId, @deviceOwnerIdAtCreation,
      @toolName, @bootId, 'dispatched', @createdAt, @createdAt, @expiresAt, @retentionUntil)`)
      .run({...record, retentionUntil: record.createdAt + 86_400_000});
    return this.find(record.operationId)!;
  }

  find(operationId: string): OperationRecord | null {
    const row = this.db.prepare(`${SELECT} WHERE operation_id = ?`).get(operationId) as OperationRecord | undefined;
    return row ? {...row, conflict: Boolean(row.conflict), cancelRequested: Boolean(row.cancelRequested)} : null;
  }

  markUnknown(operationId: string, now: number, cancelled = false): void {
    this.db.prepare(`UPDATE operations SET phase = CASE WHEN phase = 'completed' THEN phase ELSE 'unknown' END,
      updated_at = ?, cancel_requested = MAX(cancel_requested, ?) WHERE operation_id = ?`)
      .run(now, Number(cancelled), operationId);
  }

  markCancellation(operationId: string, now: number): void {
    this.db.prepare("UPDATE operations SET cancel_requested = 1, updated_at = ? WHERE operation_id = ?").run(now, operationId);
  }

  terminal(operationId: string, outcome: OperationOutcome, completedAt: number, digest: string | null, now: number, cancelRequested = false): OperationRecord | null {
    // All observations are merged synchronously; this transaction never spans I/O.
    return this.db.transaction(() => {
      const old = this.find(operationId);
      if (!old) return null;
      const conflict = Boolean((old.terminalDigest && digest && old.terminalDigest !== digest) ||
        (old.outcome && old.outcome !== "unknown" && outcome !== "unknown" && old.outcome !== outcome));
      if (conflict) {
        this.db.prepare("UPDATE operations SET conflict = 1, updated_at = ? WHERE operation_id = ?").run(now, operationId);
      } else {
        // Unknown evidence can be refined by a concrete terminal outcome. A known
        // outcome is never weakened by an unavailable/unknown observation.
        this.db.prepare(`UPDATE operations SET phase = 'completed', outcome = ?,
          completed_at = COALESCE(completed_at, ?), terminal_digest = COALESCE(terminal_digest, ?),
          updated_at = ?, cancel_requested = MAX(cancel_requested, ?) WHERE operation_id = ?`)
          .run(old.outcome && old.outcome !== "unknown" ? old.outcome : outcome, completedAt, digest, now, Number(cancelRequested), operationId);
      }
      return this.find(operationId);
    })();
  }

  cleanup(now = Date.now()): number {
    return this.db.prepare("DELETE FROM operations WHERE retention_until <= ?").run(now).changes;
  }
}
