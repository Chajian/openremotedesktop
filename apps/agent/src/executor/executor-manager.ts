import type { DeviceState } from "@open-desktop-remote/shared";

export interface ExecutorClient {
  listTools(): Promise<Array<{ name: string }>>;
  callTool(name: string, args: unknown): Promise<unknown>;
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
  private readonly invalidationListeners = new Set<() => void>();

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

  async start(): Promise<void> {
    if (this.restarting) return this.restarting;
    return this.startInternal();
  }

  private async startInternal(): Promise<void> {
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
        await client.close().catch(() => undefined);
        return;
      }
      const tools = await client.listTools();
      if (epoch !== this.epoch || tools.length === 0) {
        await client.close().catch(() => undefined);
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
    const previous = this.client;
    this.invalidateClient();
    // Do not advertise READY or accept new calls while the stale process closes.
    this.setState("EXECUTOR_FAILED");
    const epoch = this.epoch;
    const replacement = (async () => {
      if (previous) await previous.close().catch(() => undefined);
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

  async callTool(name: string, args: unknown): Promise<unknown> {
    if (this.currentState !== "READY" || !this.client) {
      throw new Error("Desktop Commander executor is not READY");
    }
    return this.client.callTool(name, args);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.invalidateClient();
    if (client) await client.close();
    if (this.currentState !== "REVOKED") {
      this.currentState = "OFFLINE";
      this.onState("OFFLINE");
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
  }
}
