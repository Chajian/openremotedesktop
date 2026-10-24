import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  Client,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";

export const DESKTOP_COMMANDER_VERSION = "0.3.1" as const;

export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type DesktopCommanderStartOptions = {
  desktopCommanderVersion?: typeof DESKTOP_COMMANDER_VERSION;
  cwd?: string;
  // Transfer lifecycle ownership before connect can spawn a subprocess.
  onCreated?: (client: DesktopCommanderClient) => void;
};

function desktopCommanderEntrypoint(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve(
    "@wonderwhy-er/desktop-commander/package.json",
  );
  return join(dirname(packageJson), "dist", "index.js");
}

export class DesktopCommanderClient {
  private readonly closeListeners = new Set<() => void>();
  private readonly processClosed = Promise.withResolvers<void>();
  private closeConfirmed = false;
  private connectStarted = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {
    // The SDK chains this observer during connect. Unlike its close() return
    // or pid getter, stdio onclose confirms the actual ChildProcess close.
    this.transport.onclose = () => this.confirmClose();
    // Drain without retaining or logging upstream diagnostics/tool contents.
    this.transport.stderr?.on("data", () => {});

    // The SDK can initiate close itself (including a failed handshake).
    // Share its public close operation so a second caller cannot skip the
    // signal sequence after the SDK has already cleared its process handle.
    const closeTransport = this.transport.close.bind(this.transport);
    let transportClosing: Promise<void> | undefined;
    this.transport.close = () => {
      if (transportClosing === undefined) {
        const closing = closeTransport();
        transportClosing = closing;
        void closing.catch(() => {
          if (transportClosing === closing) transportClosing = undefined;
        });
      }
      return transportClosing;
    };
  }

  static async start(
    options: DesktopCommanderStartOptions = {},
  ): Promise<DesktopCommanderClient> {
    const version =
      options.desktopCommanderVersion ?? DESKTOP_COMMANDER_VERSION;
    if (version !== DESKTOP_COMMANDER_VERSION) {
      throw new Error(`Unsupported Desktop Commander version: ${version}`);
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [desktopCommanderEntrypoint(), "--no-onboarding"],
      env: getDefaultEnvironment(),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stderr: "pipe",
    });
    const client = new Client({
      name: "open-desktop-remote-agent",
      version: "0.1.0",
    });
    const adapter = new DesktopCommanderClient(client, transport);

    try {
      options.onCreated?.(adapter);
      if (adapter.closePromise !== undefined) {
        throw new Error("Desktop Commander client was closed before startup");
      }
      adapter.connectStarted = true;
      await client.connect(transport);
      if (client.getServerVersion()?.version !== version) {
        throw new Error("Desktop Commander server version does not match the pinned version");
      }
      return adapter;
    } catch (error) {
      try {
        await adapter.close();
      } catch {
        throw new Error("Desktop Commander startup failed and subprocess cleanup was not confirmed");
      }
      throw error;
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined
        ? {}
        : { description: tool.description }),
      inputSchema: tool.inputSchema as Record<string, unknown>,
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: tool.outputSchema as Record<string, unknown> }),
    }));
  }

  async callTool(name: string, args: unknown, options?: { timeoutMs: number }): Promise<CallToolResult> {
    const argumentsValue =
      args !== null && typeof args === "object"
        ? (args as Record<string, unknown>)
        : {};
    return this.client.callTool({
      name,
      arguments: argumentsValue,
    }, options === undefined ? undefined : {
      // Both the per-request and total SDK timers must remain after the
      // Agent watchdog. Its recovery, not the SDK timeout, owns hung calls.
      timeout: options.timeoutMs,
      maxTotalTimeout: options.timeoutMs,
    });
  }

  onClose(handler: () => void): void {
    if (this.closeConfirmed) this.notifyClose(handler);
    else this.closeListeners.add(handler);
  }

  close(): Promise<void> {
    if (this.closePromise === undefined) {
      // Defer execution until the shared promise exists, including callbacks
      // that close this adapter synchronously from onCreated/onClose.
      const closing = Promise.resolve().then(() => this.closeProcess());
      this.closePromise = closing;
      void closing.catch(() => {
        if (this.closePromise === closing) this.closePromise = undefined;
      });
    }
    return this.closePromise;
  }

  private async closeProcess(): Promise<void> {
    if (!this.connectStarted) {
      this.confirmClose();
      return;
    }

    await this.client.close();
    if (this.closeConfirmed) return;

    // SDK 2.2.0 returns immediately after sending SIGKILL. A timeout must
    // remain a failed close, with the close event retained for later retries.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.processClosed.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Desktop Commander subprocess close was not confirmed"));
          }, 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private confirmClose(): void {
    if (this.closeConfirmed) return;
    this.closeConfirmed = true;
    this.processClosed.resolve();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) this.notifyClose(listener);
  }

  private notifyClose(handler: () => void): void {
    const warn = () => {
      process.emitWarning("Desktop Commander lifecycle observer failed", {
        code: "ODR_DESKTOP_COMMANDER_OBSERVER_FAILED",
      });
    };
    try {
      void Promise.resolve(handler()).catch(warn);
    } catch {
      warn();
    }
  }

  get serverVersion() {
    return this.client.getServerVersion();
  }
}
