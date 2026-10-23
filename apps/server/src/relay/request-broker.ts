import { randomUUID } from "node:crypto";
import {
  type ProtocolErrorCode,
  type OperationStatusMessage,
  type ToolErrorMessage,
  type ToolResultMessage,
} from "@open-desktop-remote/protocol";
import type { WebSocket } from "ws";
import type {
  ConnectionRegistry,
  LiveDeviceConnection,
} from "./connection-registry.js";

type BrokerResult = ToolResultMessage;

type PendingRequest = {
  deviceId: string;
  connection: LiveDeviceConnection;
  resolve: (value: BrokerResult) => void;
  reject: (error: RelayRequestError) => void;
  timer: NodeJS.Timeout;
};

export class RelayRequestError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "RelayRequestError";
  }
}

/** A rejection that happened before any attempt to send a command. */
export class PreDispatchRejectedError extends RelayRequestError {
  constructor(code: ProtocolErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, { ...details, dispatched: false });
    this.name = "PreDispatchRejectedError";
  }
}

export class RequestBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queries = new Map<string, {
    deviceId: string; requestId: string; bootId: string; includeResult: boolean;
    connection: LiveDeviceConnection; timer: NodeJS.Timeout;
    resolve: (value: OperationStatusMessage) => void;
    reject: (error: RelayRequestError) => void;
  }>();
  private evidence?: (message: ToolResultMessage | ToolErrorMessage, connection: LiveDeviceConnection) => boolean;
  private evidenceFailure?: (message: ToolResultMessage | ToolErrorMessage) => void;

  setEvidenceHandler(handler: NonNullable<RequestBroker["evidence"]>): void { this.evidence = handler; }
  setEvidenceFailureHandler(handler: NonNullable<RequestBroker["evidenceFailure"]>): void { this.evidenceFailure = handler; }
  connection(deviceId: string): LiveDeviceConnection | undefined { return this.registry.get(deviceId); }


  constructor(private readonly registry: ConnectionRegistry, private readonly options: {maxPendingCalls?: number} = {}) {}

  call(
    deviceId: string,
    toolName: string,
    args: unknown,
    options: { timeoutMs: number; requestId?: string; bootId?: string; expiresAt?: number; connection?: LiveDeviceConnection; onDispatched?: () => void },
  ): Promise<BrokerResult> {
    const connection = this.registry.get(deviceId);
    if (!connection || (options.connection && options.connection !== connection)) {
      return Promise.reject(
        new PreDispatchRejectedError("DEVICE_OFFLINE", "Device is offline"),
      );
    }
    if (connection.state !== "READY") {
      return Promise.reject(
        new PreDispatchRejectedError(
          "DEVICE_NOT_READY",
          `Device is not READY (state: ${connection.state})`,
          { state: connection.state },
        ),
      );
    }

    if (this.pending.size >= (this.options.maxPendingCalls ?? 1024)) {
      return Promise.reject(new PreDispatchRejectedError("REQUEST_TIMEOUT", "Request waiter capacity reached", {reason: "capacity"}));
    }
    const requestId = options.requestId ?? randomUUID();
    return new Promise<BrokerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(new RelayRequestError("REQUEST_TIMEOUT", "Tool call timed out"));
      }, options.timeoutMs);
      timer.unref();

      this.pending.set(requestId, {
        deviceId,
        connection,
        resolve,
        reject,
        timer,
      });

      try {
        connection.send({
          ...(options.bootId ? { type: "operation.call" as const, bootId: options.bootId, expiresAt: options.expiresAt! } : { type: "tool.call" as const }),
          protocolVersion: 1,
          requestId,
          deviceId,
          toolName,
          arguments:
            args !== null && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {},
        });
        // Dispatch telemetry must never change delivery semantics.
        try { options.onDispatched?.(); } catch { /* Ignore logger failure. */ }
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          new RelayRequestError(
            "EXECUTION_UNKNOWN",
            "Request dispatch failed; execution state is unknown",
          ),
        );
      }
    });
  }

  handleMessage(message: ToolResultMessage | ToolErrorMessage, socket?: WebSocket): void {
    const pending = this.pending.get(message.requestId);
    const connection = this.registry.get(message.deviceId);
    // The optional socket supports the legacy in-process API. Relay callers always
    // supply it; only authenticated socket evidence can update operation records.
    if (!connection || (socket && connection.socket !== socket)) return;
    if (socket && this.evidence) {
      try {
        if (!this.evidence(message, connection)) return;
      } catch {
        // Persistence is supplementary to an authenticated, already-correlated
        // reply. Never reclassify a SQLite outage as a malformed Relay frame.
        try { this.evidenceFailure?.(message); } catch { /* Logging must never tear down Relay. */ }
        // Unsolicited/late replies cannot be accepted without durable evidence.
        if (!pending) return;
      }
    }
    if (!pending || pending.deviceId !== message.deviceId || pending.connection !== connection) return;

    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);

    if (message.type === "tool.result") {
      pending.resolve(message);
    } else {
      pending.reject(
        new RelayRequestError(
          message.error.code,
          message.error.message,
          message.error.details,
        ),
      );
    }
  }

  cancel(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;

    const current = this.registry.get(pending.deviceId);
    if (current?.socket === pending.connection.socket) {
      try {
        current.send({
          type: "tool.cancel",
          protocolVersion: 1,
          requestId,
          deviceId: pending.deviceId,
        });
      } catch {
        // Cancellation is best-effort. Only the waiter ends; the local effect may continue.
      }
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(
      new RelayRequestError("REQUEST_CANCELLED", "Tool call cancelled"),
    );
  }

  query(deviceId: string, requestId: string, bootId: string, includeResult: boolean): Promise<OperationStatusMessage> {
    const connection = this.registry.get(deviceId);
    if (!connection?.bootId) return Promise.reject(new RelayRequestError("DEVICE_OFFLINE", "Recovery is unavailable"));
    if (this.queries.size >= 64) return Promise.reject(new RelayRequestError("REQUEST_TIMEOUT", "Operation query capacity reached", {reason: "capacity"}));
    const queryId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queries.delete(queryId);
        reject(new RelayRequestError("REQUEST_TIMEOUT", "Operation query timed out"));
      }, 5_000);
      timer.unref();
      this.queries.set(queryId, {deviceId, requestId, bootId, includeResult, connection, timer, resolve, reject});
      try { connection.send({type:"operation.query", protocolVersion:1, deviceId, requestId, bootId, queryId, includeResult}); }
      catch { clearTimeout(timer); this.queries.delete(queryId); reject(new RelayRequestError("DEVICE_OFFLINE", "Operation query disconnected")); }
    });
  }

  handleStatus(message: OperationStatusMessage, socket: WebSocket): void {
    const query = this.queries.get(message.queryId);
    const current = this.registry.get(message.deviceId);
    if (!query || !current || current !== query.connection || current.socket !== socket ||
        query.deviceId !== message.deviceId || query.requestId !== message.requestId ||
        current.bootId !== message.bootId ||
        (message.bootId !== query.bootId && message.snapshot.state !== "restarted")) return;
    const snapshot = message.snapshot;
    if (snapshot.state === "completed" && snapshot.payload.status === "available" && snapshot.payload.response) {
      const response = snapshot.payload.response;
      if (response.deviceId !== message.deviceId || response.requestId !== message.requestId) return;
    }
    clearTimeout(query.timer); this.queries.delete(message.queryId);
    if (!query.includeResult && snapshot.state === "completed" && snapshot.payload.status === "available") {
      query.resolve({...message, snapshot:{...snapshot, payload:{status:"available"}}});
    } else query.resolve(message);
  }

  handleDisconnect(deviceId: string, socket: WebSocket): void {
    for (const [queryId, query] of this.queries) {
      if (query.deviceId !== deviceId || query.connection.socket !== socket) continue;
      clearTimeout(query.timer); this.queries.delete(queryId);
      query.reject(new RelayRequestError("DEVICE_OFFLINE", "Operation query disconnected"));
    }
    for (const [requestId, pending] of this.pending) {
      if (
        pending.deviceId !== deviceId ||
        pending.connection.socket !== socket
      ) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(
        new RelayRequestError(
          "EXECUTION_UNKNOWN",
          "Device disconnected after request dispatch; execution state is unknown",
        ),
      );
    }
  }
}
