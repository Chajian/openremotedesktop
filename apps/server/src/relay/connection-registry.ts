import type { RelayMessage } from "@open-desktop-remote/protocol";
import {
  transitionDeviceState,
  type DeviceState,
} from "@open-desktop-remote/shared";
import type { WebSocket } from "ws";
import { HEARTBEAT_STALE_MS } from "./heartbeat.js";

export type LiveDeviceConnection = {
  deviceId: string;
  state: DeviceState;
  recoveryOffered?: boolean;
  bootId?: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  socket: WebSocket;
  send(message: RelayMessage): void;
};

export type LiveDeviceStatus = {
  deviceId: string;
  state: DeviceState;
  connectedAt?: number;
  lastHeartbeatAt?: number;
};

export class ConnectionRegistry {
  private readonly connections = new Map<string, LiveDeviceConnection>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  attach(deviceId: string, socket: WebSocket): LiveDeviceConnection {
    const previous = this.connections.get(deviceId);
    if (previous && previous.socket !== socket) {
      previous.socket.close(4001, "Replaced by a newer device connection");
    }
    const timestamp = this.now();
    const connection: LiveDeviceConnection = {
      deviceId,
      state: "CONNECTED",
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
      socket,
      send(message) {
        socket.send(JSON.stringify(message));
      },
    };
    this.connections.set(deviceId, connection);
    return connection;
  }

  markAuthenticated(deviceId: string, socket: WebSocket): void {
    this.markExecutorState(deviceId, socket, "AUTHENTICATED");
  }

  markExecutorState(
    deviceId: string,
    socket: WebSocket,
    next: DeviceState,
  ): void {
    const connection = this.current(deviceId, socket);
    connection.state = transitionDeviceState(connection.state, next);
  }

  heartbeat(deviceId: string, socket: WebSocket, at = this.now()): void {
    this.current(deviceId, socket).lastHeartbeatAt = at;
  }

  detach(deviceId: string, socket: WebSocket): void {
    const current = this.connections.get(deviceId);
    if (current?.socket === socket) this.connections.delete(deviceId);
  }

  get(deviceId: string): LiveDeviceConnection | undefined {
    return this.connections.get(deviceId);
  }

  snapshot(): LiveDeviceStatus[] {
    return [...this.connections.values()].map((connection) => ({
      deviceId: connection.deviceId,
      state: connection.state,
      connectedAt: connection.connectedAt,
      lastHeartbeatAt: connection.lastHeartbeatAt,
    }));
  }

  expireStale(staleMs = HEARTBEAT_STALE_MS): string[] {
    const now = this.now();
    const expired: string[] = [];
    let firstFailure: unknown;
    let terminationFailed = false;
    for (const [deviceId, connection] of this.connections) {
      if (now - connection.lastHeartbeatAt > staleMs) {
        try {
          connection.socket.terminate();
        } catch (error) {
          // Keep the unconfirmed connection registered for another attempt,
          // but do not let it prevent other expired devices from being swept.
          if (!terminationFailed) firstFailure = error;
          terminationFailed = true;
          continue;
        }
        this.connections.delete(deviceId);
        expired.push(deviceId);
      }
    }
    if (terminationFailed) throw firstFailure;
    return expired;
  }

  sweepStale(): void {
    this.expireStale(HEARTBEAT_STALE_MS);
  }

  private current(deviceId: string, socket: WebSocket): LiveDeviceConnection {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.socket !== socket) {
      throw new Error("Socket is not the active device connection");
    }
    return connection;
  }
}
