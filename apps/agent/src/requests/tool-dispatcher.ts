import {
  type ToolCallMessage,
  type ToolErrorMessage,
  type ToolResultMessage,
} from "@open-desktop-remote/protocol";
import { RequestCache } from "./request-cache.js";

const DEFAULT_MAX_RESULT_BYTES = 8 * 1024 * 1024;

type LocalExecutor = {
  callTool(name: string, args: unknown): Promise<unknown>;
};

type DispatchResult = ToolResultMessage | ToolErrorMessage;

export class ToolDispatcher {
  private readonly cache: RequestCache<DispatchResult>;
  private readonly inFlight = new Map<string, Promise<DispatchResult>>();
  private readonly cancelled = new Set<string>();
  private readonly maxResultBytes: number;

  constructor(
    private readonly executor: LocalExecutor,
    options: {
      maxResultBytes?: number;
      cache?: RequestCache<DispatchResult>;
    } = {},
  ) {
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.cache = options.cache ?? new RequestCache<DispatchResult>();
  }

  handle(call: ToolCallMessage): Promise<DispatchResult> {
    const cached = this.cache.get(call.requestId);
    if (cached) return Promise.resolve(cached);

    const active = this.inFlight.get(call.requestId);
    if (active) return active;

    const pending = this.execute(call).finally(() => {
      this.inFlight.delete(call.requestId);
      this.cancelled.delete(call.requestId);
    });
    this.inFlight.set(call.requestId, pending);
    return pending;
  }

  cancel(requestId: string): void {
    if (this.inFlight.has(requestId)) this.cancelled.add(requestId);
  }

  private async execute(call: ToolCallMessage): Promise<DispatchResult> {
    let response: DispatchResult;
    try {
      const rawResult = await this.executor.callTool(
        call.toolName,
        call.arguments,
      );

      if (this.cancelled.has(call.requestId)) {
        response = this.error(call, "REQUEST_CANCELLED", "Tool call cancelled");
      } else {
        const result = rawResult === undefined ? null : rawResult;
        let encoded: string;
        try {
          encoded = JSON.stringify(result);
        } catch {
          response = this.error(
            call,
            "TOOL_EXECUTION_ERROR",
            "Tool result is not serializable",
          );
          this.cache.set(call.requestId, response);
          return response;
        }

        const size = Buffer.byteLength(encoded, "utf8");
        if (size > this.maxResultBytes) {
          response = this.error(
            call,
            "TOOL_EXECUTION_ERROR",
            "Tool result exceeds configured relay size limit",
            { reason: "RESULT_TOO_LARGE", maxBytes: this.maxResultBytes },
          );
        } else {
          response = {
            type: "tool.result",
            protocolVersion: 1,
            requestId: call.requestId,
            deviceId: call.deviceId,
            result,
          };
        }
      }
    } catch {
      response = this.cancelled.has(call.requestId)
        ? this.error(call, "REQUEST_CANCELLED", "Tool call cancelled")
        : this.error(
            call,
            "TOOL_EXECUTION_ERROR",
            "Desktop Commander tool execution failed",
          );
    }

    this.cache.set(call.requestId, response);
    return response;
  }

  private error(
    call: ToolCallMessage,
    code: ToolErrorMessage["error"]["code"],
    message: string,
    details?: unknown,
  ): ToolErrorMessage {
    return {
      type: "tool.error",
      protocolVersion: 1,
      requestId: call.requestId,
      deviceId: call.deviceId,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    };
  }
}
