import { EventEmitter } from "node:events";
import {
  PROTOCOL_VERSION,
  parseRelayMessage,
  type RelayMessage,
} from "@open-desktop-remote/protocol";
import WebSocket from "ws";
import type { DeviceCredential } from "../credentials/credential-store.js";
import type { ExecutorManager } from "../executor/executor-manager.js";
import { ToolDispatcher } from "../requests/tool-dispatcher.js";
import { refreshRelayToken } from "../auth/device-token.js";

export type RelaySocket = EventEmitter & {
  readyState: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
};

type RelayToken = {
  accessToken: string;
  expiresAt: number;
  deviceId: string;
};

type SocketFactory = (
  url: URL,
  accessToken: string,
) => Promise<RelaySocket>;

type WaitForSocketClose = (
  socket: RelaySocket,
  signal: AbortSignal,
) => Promise<void>;

type RelayClientOptions = {
  credential: DeviceCredential;
  executor: ExecutorManager;
  refreshToken?: (credential: DeviceCredential) => Promise<RelayToken>;
  socketFactory?: SocketFactory;
  waitForSocketClose?: WaitForSocketClose;
  sleep?: (ms: number) => Promise<void>;
  heartbeatIntervalMs?: number;
  dispatcher?: ToolDispatcher;
  now?: () => number;
  random?: () => number;
  stableConnectionMs?: number;
};

function relayUrl(serverUrl: string): URL {
  const url = new URL("/relay", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

async function defaultSocketFactory(
  url: URL,
  accessToken: string,
): Promise<RelaySocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    const onOpen = () => {
      socket.off("error", onError);
      resolve(socket as unknown as RelaySocket);
    };
    socket.once("error", onError);
    socket.once("open", onOpen);
  });
}

async function defaultWaitForClose(
  socket: RelaySocket,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    socket.close();
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      socket.close(1000, "Agent stopping");
      done();
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", done);
  });
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function send(socket: RelaySocket, message: RelayMessage): void {
  socket.send(JSON.stringify(message));
}

export class RelayClient {
  private readonly refreshToken: (
    credential: DeviceCredential,
  ) => Promise<RelayToken>;
  private readonly socketFactory: SocketFactory;
  private readonly waitForSocketClose: WaitForSocketClose;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly heartbeatIntervalMs: number;
  private readonly dispatcher: ToolDispatcher;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly stableConnectionMs: number;

  constructor(private readonly options: RelayClientOptions) {
    this.refreshToken =
      options.refreshToken ?? ((credential) => refreshRelayToken(credential));
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.waitForSocketClose =
      options.waitForSocketClose ?? defaultWaitForClose;
    this.sleep = options.sleep ?? defaultSleep;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.dispatcher = options.dispatcher ?? new ToolDispatcher(options.executor);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.stableConnectionMs = options.stableConnectionMs ?? 30_000;
  }

  async connectOnce(
    signal: AbortSignal,
  ): Promise<"reconnect" | "incompatible"> {
    const token = await this.refreshToken(this.options.credential);
    if (token.deviceId !== this.options.credential.deviceId) {
      throw new Error("Relay token device does not match paired device");
    }

    const socket = await this.socketFactory(
      relayUrl(this.options.credential.serverUrl),
      token.accessToken,
    );
    let incompatible = false;

    const onMessage = (data: Buffer | string) => {
      try {
        const raw =
          typeof data === "string" ? data : data.toString("utf8");
        const message = parseRelayMessage(JSON.parse(raw));
        if (message.type === "tool.call") {
          if (message.deviceId !== this.options.credential.deviceId) {
            socket.close(4400, "Device id does not match paired device");
            return;
          }
          void this.dispatcher.handle(message).then((response) => {
            if (socket.readyState === 1) send(socket, response);
          });
          return;
        }

        if (message.type === "tool.cancel") {
          if (message.deviceId === this.options.credential.deviceId) {
            this.dispatcher.cancel(message.requestId);
          }
          return;
        }

        if (
          message.type === "server.notice" &&
          message.code === "PROTOCOL_INCOMPATIBLE"
        ) {
          incompatible = true;
          this.options.executor.markIncompatible();
          socket.close(1000, "Protocol incompatible");
          return;
        }

      } catch {
        // Ignore malformed server messages here; the server will close if needed.
      }
    };
    socket.on("message", onMessage);

    send(socket, {
      type: "agent.hello",
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.options.credential.deviceId,
      agentVersion: "0.1.0",
      protocolRange: { min: 1, max: 1 },
      platform:
        process.platform === "win32" ||
        process.platform === "darwin" ||
        process.platform === "linux"
          ? process.platform
          : "linux",
      desktopCommanderVersion: "0.2.52",
      capabilities: ["desktop-commander"],
    });

    if (this.options.executor.state() !== "READY") {
      send(socket, {
        type: "agent.executor_status",
        protocolVersion: PROTOCOL_VERSION,
        deviceId: this.options.credential.deviceId,
        state: "EXECUTOR_STARTING",
      });
      await this.options.executor.start();
    }

    if (!incompatible && this.options.executor.state() === "READY") {
      send(socket, {
        type: "agent.ready",
        protocolVersion: PROTOCOL_VERSION,
        deviceId: this.options.credential.deviceId,
        desktopCommanderVersion: "0.2.52",
        capabilities: ["desktop-commander"],
      });
    }

    const heartbeat =
      this.heartbeatIntervalMs > 0
        ? setInterval(() => {
            if (socket.readyState === 1) {
              send(socket, {
                type: "heartbeat",
                protocolVersion: PROTOCOL_VERSION,
                deviceId: this.options.credential.deviceId,
                timestamp: Date.now(),
              });
            }
          }, this.heartbeatIntervalMs)
        : null;
    heartbeat?.unref();

    try {
      await this.waitForSocketClose(socket, signal);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      socket.off("message", onMessage);
    }

    return incompatible ? "incompatible" : "reconnect";
  }

  async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const connectedAt = this.now();
      const result = await this.connectOnce(signal);
      if (result === "incompatible" || signal.aborted) return;

      if (this.now() - connectedAt >= this.stableConnectionMs) {
        attempt = 0;
      }

      const baseDelay = Math.min(30_000, 500 * 2 ** attempt);
      const jitterMultiplier = 0.75 + this.random() * 0.5;
      const delay = Math.min(30_000, Math.round(baseDelay * jitterMultiplier));
      await this.sleep(delay);
      attempt = Math.min(attempt + 1, 6);
    }
  }
}
