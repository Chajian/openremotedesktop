import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  Client,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { OwnedStdioTransport } from "./owned-stdio-transport.js";

export const DESKTOP_COMMANDER_VERSION = "0.3.1" as const;

export type ToolDefinition = Tool;

export type DesktopCommanderStartOptions = {
  desktopCommanderVersion?: typeof DESKTOP_COMMANDER_VERSION;
  cwd?: string;
  clientInfo?: { name: string; version: string };
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

// SDK 2.2.0 starts close without awaiting it when a handshake fails. Observe
// that detached rejection while returning the original rejecting promise to
// explicit owners; shutdown failure must never become a successful close.
class ObservedMcpClient extends Client {
  override close(): Promise<void> {
    const closing = super.close();
    void closing.catch(() => {
      process.emitWarning("Desktop Commander SDK close failed; subprocess ownership is retained", {
        code: "ODR_DESKTOP_COMMANDER_CLOSE_FAILED",
      });
    });
    return closing;
  }
}

export class DesktopCommanderClient {
  private readonly closeListeners = new Set<() => void>();
  private readonly processClosed = Promise.withResolvers<void>();
  private closeConfirmed = false;
  private connectStarted = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly client: Client,
    private readonly transport: OwnedStdioTransport,
  ) {
    // The SDK chains this observer during connect. The owned transport only
    // emits onclose after the actual ChildProcess close.
    this.transport.onclose = () => this.confirmClose();
    // Drain without retaining or logging upstream diagnostics/tool contents.
    this.transport.stderr?.on("data", () => {});
  }

  static async start(
    options: DesktopCommanderStartOptions = {},
  ): Promise<DesktopCommanderClient> {
    const version =
      options.desktopCommanderVersion ?? DESKTOP_COMMANDER_VERSION;
    if (version !== DESKTOP_COMMANDER_VERSION) {
      throw new Error(`Unsupported Desktop Commander version: ${version}`);
    }

    const transport = new OwnedStdioTransport({
      command: process.execPath,
      args: [desktopCommanderEntrypoint(), "--no-onboarding"],
      env: getDefaultEnvironment(),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const client = new ObservedMcpClient(options.clientInfo ?? {
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
    } catch (startupError) {
      try {
        await adapter.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          "Desktop Commander startup failed and subprocess cleanup was not confirmed",
        );
      }
      throw startupError;
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.client.listTools();
    return result.tools;
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

    // Keep an independent physical-close check if a future SDK path returns
    // without closing its transport. Never release ownership on that return.
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
