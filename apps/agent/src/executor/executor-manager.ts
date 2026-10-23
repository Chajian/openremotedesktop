import type { DeviceState } from "@open-desktop-remote/shared";

export interface ExecutorClient {
  listTools(): Promise<Array<{ name: string }>>;
  callTool(name: string, args: unknown, options?: { timeoutMs: number }): Promise<unknown>;
  close(): Promise<void>;
  onClose?(handler: () => void): void;
}

export type ExecutorManagerOptions = {
  startClient: () => Promise<ExecutorClient>;
  onState?: (state: DeviceState) => void;
};

export class ExecutorManager {
  private currentState: DeviceState = "AUTHENTICATED";
  private client: ExecutorClient | null = null;
  private startClient: () => Promise<ExecutorClient>;
  private readonly onState: (state: DeviceState) => void;
  private epoch = 0;
  private starting: { epoch: number; promise: Promise<void> } | undefined;
  private restarting: Promise<void> | undefined;
  private unconfirmedShutdown: Error | undefined;
  private readonly invalidationListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(state: DeviceState) => void>();

  constructor(options: ExecutorManagerOptions) {
    this.startClient = options.startClient;
    this.onState = options.onState ?? (() => undefined);
  }

  state(): DeviceState {
    return this.currentState;
  }

  setClientFactory(factory: () => Promise<ExecutorClient>): void {
    this.startClient = factory;
  }

  onInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => { this.invalidationListeners.delete(listener); };
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  private assertShutdownConfirmed(): void {
    if (this.unconfirmedShutdown) throw this.unconfirmedShutdown;
  }

  private async closeClient(client: ExecutorClient): Promise<void> {
    try {
      await client.close();
    } catch (cause) {
      this.unconfirmedShutdown = new Error("Previous executor shutdown could not be confirmed", { cause });
      throw this.unconfirmedShutdown;
    }
  }

  async start(): Promise<void> {
    if (this.restarting) return this.restarting;
    return this.startInternal();
  }

  private async startInternal(): Promise<void> {
    this.assertShutdownConfirmed();
    if (this.currentState === "READY" && this.client) return;
    if (this.starting?.epoch === this.epoch) return this.starting.promise;
    const epoch = this.epoch;
    const promise = this.initialize(epoch);
    const starting = { epoch, promise };
    this.starting = starting;
    try {
      await promise;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async initialize(epoch: number): Promise<void> {
    this.setState("EXECUTOR_STARTING");
    try {
      const client = await this.startClient();
      if (epoch !== this.epoch) {
        await this.closeClient(client);
        return;
      }
      const tools = await client.listTools();
      if (epoch !== this.epoch || tools.length === 0) {
        await this.closeClient(client);
        if (epoch !== this.epoch) return;
        throw new Error("Desktop Commander exposed no tools");
      }
      this.client = client;
      client.onClose?.(() => {
        if (this.client === client) this.markCrashed();
      });
      this.setState("READY");
    } catch (error) {
      if (epoch === this.epoch) {
        this.client = null;
        this.setState("EXECUTOR_FAILED");
      }
      throw error;
    }
  }

  async restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    this.assertShutdownConfirmed();
    const pendingStart = this.starting?.promise;
    const previous = this.client;
    this.invalidateClient();
    // Do not advertise READY or accept new calls while the stale process closes.
    this.setState("EXECUTOR_FAILED");
    const epoch = this.epoch;
    const replacement = (async () => {
      // A startup invalidated by this restart may still own a live subprocess.
      if (pendingStart) {
        await pendingStart.catch(() => undefined);
        this.assertShutdownConfirmed();
      }
      if (previous) await this.closeClient(previous);
      if (epoch === this.epoch) await this.startInternal();
    })();
    this.restarting = replacement;
    try {
      await replacement;
    } finally {
      if (this.restarting === replacement) this.restarting = undefined;
    }
  }

  markCrashed(): void {
    this.invalidateClient();
    if (this.currentState !== "INCOMPATIBLE") {
      this.setState("EXECUTOR_FAILED");
    }
  }

  markIncompatible(): void {
    this.invalidateClient();
    this.setState("INCOMPATIBLE");
  }

  async callTool(name: string, args: unknown, options?: { timeoutMs: number }): Promise<unknown> {
    if (this.currentState !== "READY" || !this.client) {
      throw new Error("Desktop Commander executor is not READY");
    }
    return this.client.callTool(name, args, options);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.invalidateClient();
    try {
      if (client) await this.closeClient(client);
    } finally {
      if (this.currentState !== "REVOKED") {
        this.setState("OFFLINE");
      }
    }
  }

  private invalidateClient(): void {
    this.epoch++;
    this.client = null;
    for (const listener of this.invalidationListeners) listener();
  }

  private setState(state: DeviceState): void {
    this.currentState = state;
    this.onState(state);
    for (const listener of this.stateListeners) {
      try { listener(state); } catch { /* Status observers must not affect the executor. */ }
    }
  }
}
