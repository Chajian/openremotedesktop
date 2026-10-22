import {
  fromJsonSchema,
  type CallToolResult,
  type JsonSchemaType,
  type McpServer,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  DESKTOP_COMMANDER_TOOL_MANIFEST,
  addDeviceIdToToolSchema,
} from "@open-desktop-remote/tool-contracts";
import type { OperationService } from "../operations/operation-service.js";
import type { OperationActor } from "../operations/access-policy.js";
import type { DeviceRepository } from "../devices/device-repository.js";
import type { ServerLogger } from "../logging.js";
import type { ConnectionRegistry } from "../relay/connection-registry.js";
import {
  RelayRequestError,
  type RequestBroker,
} from "../relay/request-broker.js";
import { DeviceRoutingError, selectTargetDevice } from "./device-router.js";

export type DesktopToolDependencies = {
  devices: Pick<DeviceRepository, "listOwnedDevices">;
  authOwnerId: (authInfo: AuthInfo | undefined) => string | null;
  registry: Pick<ConnectionRegistry, "snapshot">;
  broker: Pick<RequestBroker, "call">;
  operations?: Pick<OperationService, "invoke" | "query">;
  operationActor?: (authInfo: AuthInfo | undefined) => OperationActor | null;
  logger?: Pick<ServerLogger, "event">;
  toolTimeoutMs?: number;
};

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

function errorCode(error: unknown): string {
  return error instanceof DeviceRoutingError || error instanceof RelayRequestError
    ? error.code
    : "TOOL_EXECUTION_ERROR";
}

function errorResult(error: unknown): CallToolResult {
  const known =
    error instanceof DeviceRoutingError || error instanceof RelayRequestError;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : "Tool execution failed";
  const details = known ? error.details : undefined;

  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}

function splitRoutingArguments(args: Record<string, unknown>): {
  deviceId?: string;
  forwarded: Record<string, unknown>;
} {
  const { deviceId: rawDeviceId, ...forwarded } = args;
  return {
    ...(typeof rawDeviceId === "string" ? { deviceId: rawDeviceId } : {}),
    forwarded,
  };
}

function deviceStatusContent(deps: DesktopToolDependencies, ownerId: string) {
  const liveById = new Map(
    deps.registry.snapshot().map((status) => [status.deviceId, status]),
  );
  return deps.devices.listOwnedDevices(ownerId).map((device) => ({
    id: device.id,
    name: device.name,
    platform: device.platform,
    agentVersion: device.agentVersion,
    desktopCommanderVersion: device.desktopCommanderVersion,
    lastSeenAt: device.lastSeenAt,
    state:
      device.revokedAt !== null
        ? "REVOKED"
        : (liveById.get(device.id)?.state ?? "OFFLINE"),
  }));
}

export function registerDesktopCommanderTools(
  server: McpServer,
  deps: DesktopToolDependencies,
): void {
  for (const sourceTool of DESKTOP_COMMANDER_TOOL_MANIFEST) {
    const tool = addDeviceIdToToolSchema(sourceTool);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(
          tool.inputSchema as JsonSchemaType,
        ),
      },
      async (args, extra) => {
        const ownerId = deps.authOwnerId(extra.http?.authInfo);
        if (!ownerId) return errorResult(new Error("Missing authenticated account"));
        const startedAt = Date.now();
        const { deviceId, forwarded } = splitRoutingArguments(args);
        let targetDeviceId = deviceId;
        try {
          targetDeviceId = selectTargetDevice(
            deps.devices.listOwnedDevices(ownerId),
            deps.registry.snapshot(),
            deviceId,
          );
          const actor = deps.operationActor?.(extra.http?.authInfo);
          if (deps.operations && !actor) throw new Error("Missing authenticated account");
          const relayResult = deps.operations && actor
            ? await deps.operations.invoke(actor, targetDeviceId, tool.name, forwarded,
                {timeoutMs: deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS})
            : await deps.broker.call(targetDeviceId, tool.name, forwarded,
                {timeoutMs: deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS});
          deps.logger?.event("tool.call", {
            requestId: relayResult.requestId,
            deviceId: targetDeviceId,
            toolName: tool.name,
            durationMs: Date.now() - startedAt,
            success: !(relayResult.result && typeof relayResult.result === "object" && "isError" in relayResult.result && relayResult.result.isError === true),
          });
          return relayResult.result as CallToolResult;
        } catch (error) {
          deps.logger?.event("tool.call", {
            ...(targetDeviceId ? { deviceId: targetDeviceId } : {}),
            toolName: tool.name,
            durationMs: Date.now() - startedAt,
            success: false,
            errorCode: errorCode(error),
            ...(error instanceof RelayRequestError && error.details && typeof error.details === "object" && "operationId" in error.details
              ? {operationId: error.details.operationId} : {}),
          });
          return errorResult(error);
        }
      },
    );
  }

  server.registerTool(
    "odr_get_operation",
    {
      description: "Read an existing operation's execution evidence and retained result. This never re-executes the tool. Results depend on Agent process survival and cache availability.",
      inputSchema: fromJsonSchema<{operationId: string; includeResult?: boolean}>({
        type: "object", properties: {
          operationId: {type: "string", format: "uuid"},
          includeResult: {type: "boolean", default: true},
        }, required: ["operationId"], additionalProperties: false,
      }),
      annotations: {readOnlyHint: true, idempotentHint: true},
    },
    async ({operationId, includeResult}, extra) => {
      const actor = deps.operationActor?.(extra.http?.authInfo);
      const operation = deps.operations && actor
        ? await deps.operations.query(actor, operationId, includeResult ?? true)
        : {state: "not_found" as const};
      return {content: [{type:"text", text:JSON.stringify(operation)}], structuredContent:{operation}};
    },
  );

  server.registerTool(
    "list_devices",
    {
      description: "List paired devices and their current live readiness state.",
      inputSchema: fromJsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    },
    async (_args, extra) => {
      const ownerId = deps.authOwnerId(extra.http?.authInfo);
      if (!ownerId) return errorResult(new Error("Missing authenticated account"));
      const devices = deviceStatusContent(deps, ownerId);
      return {
        content: [{ type: "text", text: JSON.stringify(devices) }],
        structuredContent: { devices },
      };
    },
  );

  server.registerTool(
    "get_device_status",
    {
      description: "Get current durable and live status for one paired device.",
      inputSchema: fromJsonSchema<{ deviceId: string }>({
        type: "object",
        properties: { deviceId: { type: "string", format: "uuid" } },
        required: ["deviceId"],
        additionalProperties: false,
      }),
    },
    async ({ deviceId }, extra) => {
      const ownerId = deps.authOwnerId(extra.http?.authInfo);
      if (!ownerId) return errorResult(new Error("Missing authenticated account"));
      const status = deviceStatusContent(deps, ownerId).find(
        (device) => device.id === deviceId,
      );
      if (!status) {
        return errorResult(
          new DeviceRoutingError(
            "DEVICE_NOT_FOUND",
            "Requested device was not found",
            { deviceId },
          ),
        );
      }
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
        structuredContent: { device: status },
      };
    },
  );
}
