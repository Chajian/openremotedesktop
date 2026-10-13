import { randomUUID } from "node:crypto";
import {
  type ProtocolErrorCode,
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

export class RequestBroker {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly registry: ConnectionRegistry) {}

  call(
    deviceId: string,
    toolName: string,
    args: unknown,
    options: { timeoutMs: number },
  ): Promise<BrokerResult> {
    const connection = this.registry.get(deviceId);
    if (!connection) {
      return Promise.reject(
        new RelayRequestError("DEVICE_OFFLINE", "Device is offline"),
      );
    }
    if (connection.state !== "READY") {
      return Promise.reject(
        new RelayRequestError(
          "DEVICE_NOT_READY",
          `Device is not READY (state: ${connection.state})`,
          { state: connection.state },
        ),
      );
    }

    const requestId = randomUUID();
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
          type: "tool.call",
          protocolVersion: 1,
          requestId,
          deviceId,
          toolName,
          arguments:
            args !== null && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {},
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(
          new RelayRequestError(
            "DEVICE_OFFLINE",
            "Device disconnected before request dispatch",
          ),
        );
      }
    });
  }

  handleMessage(message: ToolResultMessage | ToolErrorMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.deviceId !== message.deviceId) return;

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
        // Cancellation is best-effort; the upstream result is still cancelled.
      }
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(
      new RelayRequestError("REQUEST_CANCELLED", "Tool call cancelled"),
    );
  }

  handleDisconnect(deviceId: string, socket: WebSocket): void {
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
