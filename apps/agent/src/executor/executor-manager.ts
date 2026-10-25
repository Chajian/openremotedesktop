import type { DeviceState } from "@open-desktop-remote/shared";

export type ExecutorTool = {
  name: string;
  inputSchema?: Record<string, unknown> | undefined;
  outputSchema?: Record<string, unknown> | undefined;
};

export interface ExecutorClient {
  listTools(options?: { signal?: AbortSignal }): Promise<ExecutorTool[]>;
  callTool(name: string, args: unknown, options?: { timeoutMs: number }): Promise<unknown>;
  close(): Promise<void>;
  onClose?(handler: () => void): void;
}

export type ExecutorManagerOptions = {
  /** Register ownership before awaiting a factory's subprocess handshake. */
  startClient: (onCreated: (client: ExecutorClient) => void, signal: AbortSignal) => Promise<ExecutorClient>;
  onState?: (state: DeviceState) => void;
  validateTools?: (tools: readonly ExecutorTool[]) => void;
};

type ExecutorOwnership = {
  client: ExecutorClient;
  closing: Promise<void> | undefined;
};

type Initialization = {
  controller: AbortController;
  ownership: ExecutorOwnership | undefined;
  factorySettled: boolean;
  finished: boolean;
};

export class ExecutorManager {
  private currentState: DeviceState = "AUTHENTICATED";
  private client: ExecutorClient | null = null;
  // Readiness can be revoked synchronously; ownership ends only after close resolves.
  private ownedClient: ExecutorOwnership | null = null;
  private drainingClient: ExecutorClient | undefined;
  private startClient: ExecutorManagerOptions["startClient"];
  private readonly onState: (state: DeviceState) => void;
  private readonly validateTools: (tools: readonly ExecutorTool[]) => void;
  private epoch = 0;
  private starting: { epoch: number; promise: Promise<void> } | undefined;
  private restarting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private unconfirmedShutdown: Error | undefined;
  private initializing: Initialization | undefined;
  private pendingFactory: { initialization: Initialization; error: Error } | undefined;
  private readonly invalidationListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(state: DeviceState) => void>();

  constructor(options: ExecutorManagerOptions) {
    this.startClient = options.startClient;
    this.onState = options.onState ?? (() => undefined);
    this.validateTools = options.validateTools ?? (() => undefined);
  }

  state(): DeviceState {
    return this.currentState;
  }

  setClientFactory(factory: ExecutorManagerOptions["startClient"]): void {
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
    if (this.pendingFactory) throw this.pendingFactory.error;
  }

  private async closeOwnedClient(): Promise<void> {
    if (this.pendingFactory) throw this.pendingFactory.error;
    if (this.ownedClient) await this.closeClient(this.ownedClient);
  }

  private closeClient(ownership: ExecutorOwnership): Promise<void> {
    if (ownership.closing === undefined) {
      ownership.closing = Promise.resolve().then(async () => {
        const { client } = ownership;
        this.drainingClient = client;
        try {
          await client.close();
          if (this.ownedClient === ownership) {
            this.ownedClient = null;
            this.unconfirmedShutdown = undefined;
          }
        } catch (cause) {
          const error = new Error("Previous executor shutdown could not be confirmed", { cause });
          if (this.ownedClient === ownership) this.unconfirmedShutdown = error;
          throw error;
        } finally {
          if (this.drainingClient === client) this.drainingClient = undefined;
        }
      });
    }
    return ownership.closing;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation);
    // The public promise preserves the error. The queue itself must still permit
    // a later explicit close to retry cleanup after a failed operation.
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertCanStart(): void {
    this.assertShutdownConfirmed();
    if (this.closing) throw new Error("Executor shutdown is still in progress");
    if (this.currentState === "INCOMPATIBLE") throw new Error("Executor protocol is incompatible");
  }

  async start(): Promise<void> {
    this.assertCanStart();
    if (this.restarting) return this.restarting;
    if (this.currentState === "READY" && this.client) return;
    if (this.starting?.epoch === this.epoch) return this.starting.promise;
    const epoch = this.epoch;
    const promise = this.enqueue(async () => {
      if (epoch !== this.epoch) return;
      this.assertShutdownConfirmed();
      await this.closeOwnedClient();
      if (epoch === this.epoch) await this.initialize(epoch);
    });
    const starting = { epoch, promise };
    this.starting = starting;
    try {
      await promise;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async initialize(epoch: number): Promise<void> {
    const initialization: Initialization = {
      controller: new AbortController(), ownership: undefined, factorySettled: true, finished: false,
    };
    this.initializing = initialization;
    const { signal } = initialization.controller;
    const onCreated = (client: ExecutorClient) => {
      // Keep the attempt's identity after close so a late factory result cannot
      // reclaim a closed client or overwrite ownership of its replacement.
      if (initialization.ownership?.client === client) return;
      if (initialization.ownership || this.ownedClient) throw new Error("Executor factory registered more than one client");
      const ownership: ExecutorOwnership = { client, closing: undefined };
      initialization.ownership = ownership;
      this.ownedClient = ownership;
      // This also observes exits during the factory's handshake.
      client.onClose?.(() => {
        if (this.ownedClient === ownership && this.drainingClient !== client && epoch === this.epoch) {
          this.markCrashed();
        }
      });
      if (initialization.finished) {
        // The queue has already left this cancelled factory. Clean only the
        // client it eventually hands over, never whichever client is current.
        void this.enqueue(() => this.closeClient(ownership)).catch(() => undefined);
        if (this.pendingFactory?.initialization === initialization) this.pendingFactory = undefined;
      }
    };
    try {
      this.setState("EXECUTOR_STARTING");
      if (epoch !== this.epoch) return;
      let published = false;
      let failed = false;
      let failure: unknown;
      try {
        initialization.factorySettled = false;
        let factory: Promise<ExecutorClient>;
        try {
          factory = this.startClient(onCreated, signal);
        } catch (error) {
          initialization.factorySettled = true;
          throw error;
        }
        const observedFactory = factory.then(client => {
          initialization.factorySettled = true;
          onCreated(client);
          return client;
        }, error => {
          initialization.factorySettled = true;
          if (this.pendingFactory?.initialization === initialization) this.pendingFactory = undefined;
          throw error;
        });
        const client = await this.waitForInitialization(observedFactory, signal);
        if (epoch === this.epoch) {
          const tools = await this.waitForInitialization(client.listTools({ signal }), signal);
          if (epoch === this.epoch) {
            if (tools.length === 0) throw new Error("Desktop Commander exposed no tools");
            this.validateTools(tools);
            if (epoch === this.epoch) {
              this.client = client;
              published = true;
              this.setState("READY");
            }
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          failed = true;
          failure = error;
          if (epoch === this.epoch) {
            this.client = null;
            this.setState("EXECUTOR_FAILED");
          }
        }
      }
      if (!published) {
        if (!initialization.ownership && !initialization.factorySettled) {
          const error = new Error("Previous executor shutdown could not be confirmed: client factory is still pending");
          this.pendingFactory = { initialization, error };
          throw error;
        }
        try {
          if (initialization.ownership) await this.closeClient(initialization.ownership);
        } catch (shutdownError) {
          if (failed) throw new AggregateError([failure, shutdownError], "Executor initialization failed and shutdown could not be confirmed");
          throw shutdownError;
        }
      }
      if (failed) throw failure;
    } finally {
      initialization.finished = true;
      if (this.initializing === initialization) this.initializing = undefined;
    }
  }

  private async waitForInitialization<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const stopped = Promise.withResolvers<never>();
    const abort = () => { stopped.reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      // Passing a signal alone cannot release the queue if an injected factory
      // or client ignores cancellation. Both late success and rejection remain observed.
      return await Promise.race([pending, stopped.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async restart(): Promise<void> {
    this.assertCanStart();
    if (this.restarting) return this.restarting;
    const epoch = this.epoch + 1;
    const replacement = this.enqueue(async () => {
      this.assertShutdownConfirmed();
      await this.closeOwnedClient();
      if (epoch === this.epoch) await this.initialize(epoch);
    });
    this.restarting = replacement;
    this.invalidateClient("EXECUTOR_FAILED");
    try {
      await replacement;
    } finally {
      if (this.restarting === replacement) this.restarting = undefined;
    }
  }

  markCrashed(): void {
    this.invalidateClient(this.currentState === "INCOMPATIBLE" ? "INCOMPATIBLE" : "EXECUTOR_FAILED");
  }

  markIncompatible(): void {
    this.invalidateClient("INCOMPATIBLE");
  }

  async callTool(name: string, args: unknown, options?: { timeoutMs: number }): Promise<unknown> {
    if (this.currentState !== "READY" || !this.client) {
      throw new Error("Desktop Commander executor is not READY");
    }
    return this.client.callTool(name, args, options);
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const retry = this.unconfirmedShutdown;
    const shutdown = this.enqueue(() => {
      // Only a later explicit close may retry a failure already reported to its
      // caller. A close queued behind cancellation shares that cleanup result.
      if (retry && retry === this.unconfirmedShutdown && this.ownedClient) this.ownedClient.closing = undefined;
      return this.closeOwnedClient();
    });
    this.closing = shutdown;
    this.invalidateClient(this.currentState === "REVOKED" ? "REVOKED" : "OFFLINE");
    try {
      await shutdown;
    } finally {
      if (this.closing === shutdown) this.closing = undefined;
    }
  }

  private invalidateClient(state: DeviceState): void {
    this.epoch++;
    this.client = null;
    this.initializing?.controller.abort();
    this.setState(state);
    for (const listener of this.invalidationListeners) this.notifyObserver(listener);
  }

  private setState(state: DeviceState): void {
    this.currentState = state;
    this.notifyObserver(() => this.onState(state));
    for (const listener of this.stateListeners) {
      this.notifyObserver(() => listener(state));
    }
  }

  private notifyObserver(listener: () => void): void {
    const warn = () => {
      process.emitWarning("Executor lifecycle observer failed", { code: "ODR_EXECUTOR_OBSERVER_FAILED" });
    };
    try {
      // Callback completion does not own lifecycle progress. Observe rejected
      // async callbacks as well as synchronous throws without blocking cleanup.
      void Promise.resolve(listener()).catch(warn);
    } catch {
      // Observers do not own lifecycle progress. Report the failure without
      // logging arbitrary callback errors that could contain tool data.
      warn();
    }
  }
}
