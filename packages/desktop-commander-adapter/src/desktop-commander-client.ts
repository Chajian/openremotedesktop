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

  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {
    this.client.onclose = () => {
      for (const listener of this.closeListeners) listener();
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

    try {
      await client.connect(transport);
      return new DesktopCommanderClient(client, transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
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
    this.closeListeners.add(handler);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  get serverVersion() {
    return this.client.getServerVersion();
  }
}
