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

  async start(): Promise<void> {
    if (this.currentState === "READY" && this.client) return;

    this.setState("EXECUTOR_STARTING");
    try {
      const client = await this.startClient();
      const tools = await client.listTools();
      if (tools.length === 0) {
        await client.close().catch(() => undefined);
        throw new Error("Desktop Commander exposed no tools");
      }
      this.client = client;
      client.onClose?.(() => this.markCrashed());
      this.setState("READY");
    } catch (error) {
      this.client = null;
      this.setState("EXECUTOR_FAILED");
      throw error;
    }
  }

  async restart(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }
    await this.start();
  }

  markCrashed(): void {
    this.client = null;
    if (this.currentState !== "INCOMPATIBLE") {
      this.setState("EXECUTOR_FAILED");
    }
  }

  markIncompatible(): void {
    this.client = null;
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
    this.client = null;
    if (client) await client.close();
    if (this.currentState !== "REVOKED") {
      this.currentState = "OFFLINE";
      this.onState("OFFLINE");
    }
  }

  private setState(state: DeviceState): void {
    this.currentState = state;
    this.onState(state);
  }
}
