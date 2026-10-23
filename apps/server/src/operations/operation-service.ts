import { createHash, randomUUID } from "node:crypto";
import type {
  OperationSnapshot,
  ToolErrorMessage,
  ToolResultMessage,
  OperationStatusMessage,
} from "@open-desktop-remote/protocol";
import type { WebSocket } from "ws";
import type { ServerLogger } from "../logging.js";
import type { LiveDeviceConnection } from "../relay/connection-registry.js";
import { PreDispatchRejectedError, RelayRequestError, type RequestBroker } from "../relay/request-broker.js";
import type { OperationAccessPolicy, OperationActor } from "./access-policy.js";
import {
  OperationRepository,
  type OperationOutcome,
  type OperationRecord,
} from "./operation-repository.js";

export type ResultAvailability =
  | "available" | "expired" | "evicted" | "unavailable"
  | "offline" | "legacy" | "restarted" | "not_found"
  | "timeout" | "conflict" | "running";

export type OperationQueryResult = { state: "not_found" } | {
  operationId: string;
  phase: OperationRecord["phase"];
  outcome: OperationOutcome | null;
  resultAvailability: ResultAvailability;
  cancelRequested: boolean;
  snapshot?: OperationSnapshot;
  reason?: "capacity";
};

type OperationResponse = ToolResultMessage | ToolErrorMessage;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    );
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(response: OperationResponse): string {
  return createHash("sha256").update(canonical(response)).digest("hex");
}

function outcome(response: OperationResponse): OperationOutcome {
  if (response.type === "tool.error") {
    return response.error.code === "EXECUTION_UNKNOWN" ? "unknown" : "error";
  }
  const result = response.result;
  return result && typeof result === "object" && "isError" in result && result.isError === true
    ? "error" : "success";
}

export class OperationService {
  private readonly now: () => number;
  private readonly legacySockets = new WeakMap<WebSocket, Map<string, number>>();

  constructor(
    private readonly repository: OperationRepository,
    private readonly broker: RequestBroker,
    private readonly policy: OperationAccessPolicy,
    private readonly options: {
      now?: () => number;
      logger?: Pick<ServerLogger, "event">;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    broker.setEvidenceHandler((response, connection) => this.observe(response, connection));
    broker.setEvidenceFailureHandler((message) => {
      this.options.logger?.event("operation.evidence_store_failed", {
        operationId: message.requestId,
        deviceId: message.deviceId,
      });
    });
  }

  private pruneLegacy(socket: WebSocket): Map<string, number> | undefined {
    const ids = this.legacySockets.get(socket);
    if (ids) {
      const now = this.now();
      for (const [id, expiresAt] of ids) if (expiresAt <= now) ids.delete(id);
    }
    return ids;
  }

  private observe(response: OperationResponse, connection: LiveDeviceConnection): boolean {
    const legacyIds = this.pruneLegacy(connection.socket);
    const record = this.repository.find(response.requestId);
    if (!record) return true; // Legacy API callers without an operation record.
    const sameProcess = record.bootId
      ? record.bootId === connection.bootId
      : legacyIds?.has(record.operationId);
    if (record.deviceId !== response.deviceId || !sameProcess) return false;

    const updated = this.repository.terminal(
      record.operationId, outcome(response), this.now(), digest(response), this.now(),
    );
    this.options.logger?.event("operation.terminal", {
      operationId: record.operationId,
      deviceId: record.deviceId,
      outcome: updated?.outcome,
      conflict: updated?.conflict,
    });
    return !updated?.conflict;
  }

  async invoke(
    actor: OperationActor,
    deviceId: string,
    toolName: string,
    args: unknown,
    options: { timeoutMs: number },
  ): Promise<ToolResultMessage> {
    this.repository.cleanup(this.now());
    if (!await this.policy.allows(actor, deviceId)) {
      throw new RelayRequestError("DEVICE_NOT_FOUND", "Requested device was not found");
    }
    const connection = this.broker.connection(deviceId);
    if (!connection) throw new RelayRequestError("DEVICE_OFFLINE", "Device is offline");
    if (connection.state !== "READY") {
      throw new RelayRequestError("DEVICE_NOT_READY", "Device is not READY");
    }

    const operationId = randomUUID();
    const now = this.now();
    const record = this.repository.create({
      operationId,
      requestedByUserId: actor.userId,
      originatingClientId: actor.clientId,
      deviceId,
      deviceOwnerIdAtCreation: actor.userId,
      toolName,
      bootId: connection.bootId ?? null,
      createdAt: now,
      expiresAt: now + 60_000,
    });
    if (!record.bootId) {
      let ids = this.pruneLegacy(connection.socket);
      if (!ids) {
        ids = new Map();
        this.legacySockets.set(connection.socket, ids);
      }
      ids.set(operationId, record.retentionUntil);
    }
    try {
      const result = await this.broker.call(deviceId, toolName, args, {
        timeoutMs: options.timeoutMs,
        requestId: operationId,
        connection,
        onDispatched: () => this.options.logger?.event("operation.dispatch", {
          operationId, deviceId, toolName, recovery: Boolean(record.bootId),
        }),
        ...(record.bootId ? { bootId: record.bootId, expiresAt: record.expiresAt } : {}),
      });
      if (!await this.policy.allows(actor, deviceId, record)) {
        throw new RelayRequestError("DEVICE_NOT_FOUND", "Requested device was not found");
      }
      return result;
    } catch (error) {
      if (error instanceof PreDispatchRejectedError) {
        this.repository.discardNotDispatched(operationId);
        if (!await this.policy.allows(actor, deviceId, record)) {
          throw new RelayRequestError("DEVICE_NOT_FOUND", "Requested device was not found");
        }
        // No operation ID or recovery promise for a command that was never sent.
        throw error;
      }
      this.repository.markUnknown(operationId, this.now(),
        error instanceof RelayRequestError && error.code === "REQUEST_CANCELLED");
      if (!await this.policy.allows(actor, deviceId, record)) {
        throw new RelayRequestError("DEVICE_NOT_FOUND", "Requested device was not found");
      }
      if (error instanceof RelayRequestError) {
        throw new RelayRequestError(error.code, error.message, {
          ...(error.details && typeof error.details === "object" ? error.details : {}),
          operationId,
          recovery: record.bootId !== null,
        });
      }
      throw error;
    }
  }

  async query(
    actor: OperationActor,
    operationId: string,
    includeResult = true,
  ): Promise<OperationQueryResult> {
    this.repository.cleanup(this.now());
    const record = this.repository.find(operationId);
    if (!record || !await this.policy.allows(actor, record.deviceId, record)) {
      return { state: "not_found" };
    }

    const connection = this.broker.connection(record.deviceId);
    let availability: ResultAvailability = "unavailable";
    let reason: "capacity" | undefined;
    let snapshot: OperationSnapshot | undefined;
    if (!connection) availability = "offline";
    else if (!record.bootId || !connection.bootId) availability = "legacy";
    else if (record.bootId !== connection.bootId) availability = "restarted";
    else {
      let status: OperationStatusMessage | undefined;
      try {
        status = await this.broker.query(record.deviceId, operationId, record.bootId, includeResult);
      } catch (error) {
        if (!(error instanceof RelayRequestError) ||
            (error.code !== "REQUEST_TIMEOUT" && error.code !== "DEVICE_OFFLINE")) throw error;
        const capacity = error.details && typeof error.details === "object" &&
          "reason" in error.details && error.details.reason === "capacity";
        reason = capacity ? "capacity" : undefined;
        availability = capacity ? "unavailable" : error.code === "REQUEST_TIMEOUT" ? "timeout" : "offline";
      }
      if (status) {
        snapshot = status.snapshot;
        if (snapshot.state === "completed") {
          const response = snapshot.payload.status === "available"
            ? snapshot.payload.response : undefined;
          this.repository.terminal(
            operationId,
            response ? outcome(response) : snapshot.outcome,
            snapshot.completedAt,
            response ? digest(response) : null,
            this.now(),
            snapshot.cancelRequested,
          );
          availability = snapshot.payload.status;
        } else {
          if (snapshot.state === "running" && snapshot.cancelRequested) {
            this.repository.markCancellation(operationId, this.now());
          }
          availability = snapshot.state;
        }
      }
    }

    if (!await this.policy.allows(actor, record.deviceId, record)) return { state: "not_found" };
    const current = this.repository.find(operationId);
    if (!current) return { state: "not_found" };
    // Never surface a conflicting body or let a running observation replace
    // durable terminal evidence. Missing-cache evidence remains explicit.
    if (current.conflict) {
      availability = "conflict";
      snapshot = undefined;
    }
    if (current.phase === "completed" && snapshot?.state === "running") {
      snapshot = undefined;
      availability = "unavailable";
    }
    return {
      operationId,
      phase: current.phase,
      outcome: current.outcome,
      resultAvailability: availability,
      cancelRequested: current.cancelRequested,
      ...(snapshot ? { snapshot } : {}),
      ...(reason ? { reason } : {}),
    };
  }
}
