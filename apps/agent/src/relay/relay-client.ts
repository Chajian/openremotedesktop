import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  OPERATION_RECOVERY_CAPABILITY,
  OPERATION_RECOVERY_NOTICE,
  parseRelayMessage,
  type RelayMessage,
} from "@open-desktop-remote/protocol";
import WebSocket from "ws";
import type { DeviceCredential } from "../credentials/credential-store.js";
import type { ExecutorManager } from "../executor/executor-manager.js";
import { ToolDispatcher } from "../requests/tool-dispatcher.js";
import { OperationCoordinator, OperationStore } from "../requests/operation-store.js";
import { OperationQuery } from "../requests/operation-query.js";
import { DeviceCredentialRejectedError, refreshRelayToken } from "../auth/device-token.js";
import { ServerRequestError } from "../http/server-client.js";

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

export type RelayRuntimeIdentity = Readonly<{
  agentVersion: string;
  desktopCommanderVersion: string;
  platform: "win32" | "darwin" | "linux";
  toolsHash?: string;
}>;

export type RelayClientOptions = {
  credential: DeviceCredential;
  executor: ExecutorManager;
  identity: RelayRuntimeIdentity;
  refreshToken?: (credential: DeviceCredential) => Promise<RelayToken>;
  socketFactory?: SocketFactory;
  waitForSocketClose?: WaitForSocketClose;
  sleep?: (ms: number) => Promise<void>;
  heartbeatIntervalMs?: number;
  dispatcher?: ToolDispatcher;
  operations?: OperationCoordinator;
  bootId?: string;
  now?: () => number;
  random?: () => number;
  stableConnectionMs?: number;
  /** Hard cap for a single unresponsive local MCP execution (default: 10m). */
  stalledOperationTimeoutMs?: number;
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
      // ws also emits permanent protocol/TLS validation errors here. Preserve
      // the original error so only known network codes qualify for retry.
      reject(error);
    };
    const onOpen = () => {
      socket.off("error", onError);
      resolve(socket as unknown as RelaySocket);
    };
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new ServerRequestError(response.statusCode ?? 500, null));
      socket.terminate();
    });
    socket.once("error", onError);
    socket.once("open", onOpen);
  });
}

async function defaultWaitForClose(
  socket: RelaySocket,
  signal: AbortSignal,
): Promise<void> {
  if (socket.readyState !== 1) return;
  if (signal.aborted) {
    socket.close();
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      socket.off("close", done);
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

class RelayTransportError extends Error {
  constructor() { super("Relay transport connection failed"); }
}

function retryableTransport(error: unknown): boolean {
  if (error instanceof DeviceCredentialRejectedError) return false;
  if (error instanceof ServerRequestError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  if (error instanceof RelayTransportError) return true;
  return error instanceof Error && "code" in error && [
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN",
  ].includes(String(error.code));
}

async function sleepUntilAbort(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let abort!: () => void;
  const stopped = new Promise<void>((resolve) => {
    abort = resolve;
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([sleep(ms, signal), stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });

function send(socket: RelaySocket, message: RelayMessage): boolean {
  if (socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    // Transport failure must not discard already saved execution evidence.
    return false;
  }
}

const PROCESS_BOOT_ID = randomUUID();
type ReportedExecutorState = "EXECUTOR_FAILED" | "EXECUTOR_STARTING" | "INCOMPATIBLE";
type RelaySession = { socket: RelaySocket; recovery: boolean; executorState?: ReportedExecutorState };

export class RelayClient {
  readonly bootId: string;
  private readonly operations: OperationCoordinator;
  private readonly operationQuery: OperationQuery;
  private session: RelaySession | undefined;
  private connectionAttempt = 0;
  private readonly refreshToken: (
    credential: DeviceCredential,
  ) => Promise<RelayToken>;
  private readonly socketFactory: SocketFactory;
  private readonly waitForSocketClose: WaitForSocketClose;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly heartbeatIntervalMs: number;
  private readonly dispatcher: ToolDispatcher;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly stableConnectionMs: number;
  private readonly identity: RelayRuntimeIdentity;

  constructor(private readonly options: RelayClientOptions) {
    this.identity = { ...options.identity };
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
    this.bootId = options.bootId ?? options.operations?.store.bootId ?? PROCESS_BOOT_ID;
    this.operations = options.operations ?? new OperationCoordinator(options.executor,
      new OperationStore({ deviceId: options.credential.deviceId, bootId: this.bootId, now: this.now }),
      { ...(options.stalledOperationTimeoutMs === undefined ? {} : { maxExecutionMs: options.stalledOperationTimeoutMs }), recoverExecutor: () => this.recoverStalledExecutor() });
    if (this.operations.store.bootId !== this.bootId || this.operations.store.deviceId !== options.credential.deviceId) {
      throw new Error("Operation store identity does not match this Agent");
    }
    this.operationQuery = new OperationQuery(this.operations.store);
    options.executor.onInvalidated?.(() => this.operations.invalidateRunning());
  }

  private async recoverStalledExecutor(): Promise<void> {
    const original = this.session;
    if (original) this.reportExecutorState(original, "EXECUTOR_FAILED");
    try {
      await this.options.executor.restart();
      if (this.options.executor.state() !== "READY") {
        if (original) this.reportExecutorState(original, "EXECUTOR_FAILED");
        return;
      }
      if (original) this.reportReady(original);
    } catch (cause) {
      if (original) this.reportExecutorState(original, "EXECUTOR_FAILED");
      throw new Error("Stalled local executor could not be restarted", { cause });
    }
  }

  private reportExecutorState(session: RelaySession, state: ReportedExecutorState): void {
    if (this.session !== session || session.executorState === state) return;
    if (send(session.socket, {
      type: "agent.executor_status", protocolVersion: PROTOCOL_VERSION,
      deviceId: this.options.credential.deviceId, state,
    })) session.executorState = state;
  }

  private reportReady(session: RelaySession): void {
    if (this.session !== session || this.options.executor.state() !== "READY") return;
    if (send(session.socket, {
      type: "agent.ready", protocolVersion: PROTOCOL_VERSION,
      deviceId: this.options.credential.deviceId,
      desktopCommanderVersion: this.identity.desktopCommanderVersion,
      ...(this.identity.toolsHash === undefined ? {} : { toolsHash: this.identity.toolsHash }),
      capabilities: ["desktop-commander", OPERATION_RECOVERY_CAPABILITY],
    })) delete session.executorState;
  }

  async connectOnce(
    signal: AbortSignal,
  ): Promise<"reconnect" | "incompatible"> {
    const attempt = ++this.connectionAttempt;
    let token: RelayToken;
    try {
      token = await this.refreshToken(this.options.credential);
    } catch (error) {
      // Fetch rejects network failures with TypeError; keep this classification
      // at the token request boundary so executor/programmer failures stay terminal.
      if (error instanceof TypeError || retryableTransport(error)) throw new RelayTransportError();
      throw error;
    }
    if (attempt !== this.connectionAttempt || signal.aborted) return "reconnect";
    if (token.deviceId !== this.options.credential.deviceId) {
      throw new DeviceCredentialRejectedError();
    }

    let socket: RelaySocket;
    try {
      socket = await this.socketFactory(relayUrl(this.options.credential.serverUrl), token.accessToken);
    } catch (error) {
      if (retryableTransport(error)) throw new RelayTransportError();
      throw error;
    }
    if (attempt !== this.connectionAttempt || signal.aborted) {
      socket.close(1000, "Superseded connection");
      return "reconnect";
    }
    const previous = this.session;
    const session: RelaySession = { socket, recovery: false };
    this.session = session;
    previous?.socket.close(1000, "Superseded connection");
    let incompatible = false;
    const onClose = () => { if (this.session === session) this.session = undefined; };
    socket.once("close", onClose);
    const onSocketError = () => { socket.terminate(); };
    socket.on("error", onSocketError);

    const onMessage = (data: Buffer | string) => {
      if (this.session !== session || socket.readyState !== 1) return;
      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const message = parseRelayMessage(JSON.parse(raw));
        if (message.deviceId !== undefined && message.deviceId !== this.options.credential.deviceId) {
          socket.close(4400, "Device id does not match paired device");
          return;
        }
        if (message.type === "server.notice") {
          if (message.code === "PROTOCOL_INCOMPATIBLE") {
            incompatible = true;
            this.options.executor.markIncompatible();
            socket.close(1000, "Protocol incompatible");
          } else if (message.code === OPERATION_RECOVERY_NOTICE && !session.recovery) {
            session.recovery = send(socket, {
              type: "agent.recovery", protocolVersion: PROTOCOL_VERSION,
              deviceId: this.options.credential.deviceId, bootId: this.bootId,
            });
          }
          return;
        }
        if (message.type === "operation.call" || message.type === "operation.query") {
          if (!session.recovery) {
            socket.close(4400, "Operation recovery was not negotiated");
            return;
          }
          if (message.type === "operation.query") {
            send(socket, this.operationQuery.handle(message));
          } else {
            void this.operations.handle(message).then((response) => {
              // Completion belongs to the operation, not the socket which submitted it.
              const current = this.session;
              if (current?.recovery) send(current.socket, response);
            }).catch(() => undefined);
          }
          return;
        }
        if (message.type === "tool.call") {
          void this.dispatcher.handle(message).then((response) => {
            if (this.session === session) send(socket, response);
          }).catch(() => undefined);
          return;
        }
        if (message.type === "tool.cancel") {
          this.dispatcher.cancel(message.requestId);
          this.operations.cancel(message.requestId);
          return;
        }
        socket.close(4400, "Unexpected message direction");
      } catch {
        // Preserve legacy tolerance for malformed messages; no malformed frame executes.
      }
    };
    socket.on("message", onMessage);

    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const unsubscribeState = this.options.executor.onStateChanged((state) => {
      if (state === "EXECUTOR_STARTING" || state === "EXECUTOR_FAILED" || state === "INCOMPATIBLE") {
        this.reportExecutorState(session, state);
      }
    });
    try {
      send(socket, {
        type: "agent.hello",
        protocolVersion: PROTOCOL_VERSION,
        deviceId: this.options.credential.deviceId,
        agentVersion: this.identity.agentVersion,
        protocolRange: { min: 1, max: 1 },
        platform: this.identity.platform,
        desktopCommanderVersion: this.identity.desktopCommanderVersion,
        capabilities: ["desktop-commander", OPERATION_RECOVERY_CAPABILITY],
      });

      if (this.options.executor.state() !== "READY") {
        this.reportExecutorState(session, "EXECUTOR_STARTING");
        await this.options.executor.start();
      }

      if (!incompatible) this.reportReady(session);

      heartbeat =
        this.heartbeatIntervalMs > 0
          ? setInterval(() => {
              if (this.session === session && socket.readyState === 1) {
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

      await this.waitForSocketClose(socket, signal);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribeState();
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onSocketError);
      if (this.session === session) this.session = undefined;
      if (socket.readyState === 1) socket.close(1000, "Connection ended");
    }

    return incompatible ? "incompatible" : "reconnect";
  }

  async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const connectedAt = this.now();
      try {
        const result = await this.connectOnce(signal);
        if (result === "incompatible" || signal.aborted) return;
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof RelayTransportError)) throw error;
      }

      if (this.now() - connectedAt >= this.stableConnectionMs) {
        attempt = 0;
      }

      const baseDelay = Math.min(30_000, 500 * 2 ** attempt);
      const jitterMultiplier = 0.75 + this.random() * 0.5;
      const delay = Math.min(30_000, Math.round(baseDelay * jitterMultiplier));
      await sleepUntilAbort(this.sleep, delay, signal);
      attempt = Math.min(attempt + 1, 6);
    }
  }
}
