import { z } from "zod";
import { ProtocolErrorEnvelopeSchema } from "./errors.js";
import { PROTOCOL_VERSION } from "./version.js";

const DeviceIdSchema = z.string().uuid();
const RequestIdSchema = z.string().uuid();
const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
const ProtocolRangeSchema = z
  .object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .strict();

const AgentHelloSchema = z
  .object({
    type: z.literal("agent.hello"),
    protocolVersion: ProtocolVersionSchema,
    deviceId: DeviceIdSchema,
    agentVersion: z.string().min(1),
    protocolRange: ProtocolRangeSchema,
    platform: z.enum(["win32", "darwin", "linux"]),
    desktopCommanderVersion: z.string().min(1),
    capabilities: z.array(z.string().min(1)),
  })
  .strict();

const AgentReadySchema = z
  .object({
    type: z.literal("agent.ready"),
    protocolVersion: ProtocolVersionSchema,
    deviceId: DeviceIdSchema,
    desktopCommanderVersion: z.string().min(1),
    capabilities: z.array(z.string().min(1)),
    toolsHash: z.string().min(1).optional(),
  })
  .strict();

const AgentExecutorStatusSchema = z
  .object({
    type: z.literal("agent.executor_status"),
    protocolVersion: ProtocolVersionSchema,
    deviceId: DeviceIdSchema,
    state: z.enum([
      "EXECUTOR_STARTING",
      "READY",
      "EXECUTOR_FAILED",
      "INCOMPATIBLE",
    ]),
    message: z.string().optional(),
  })
  .strict();

const HeartbeatSchema = z
  .object({
    type: z.literal("heartbeat"),
    protocolVersion: ProtocolVersionSchema,
    deviceId: DeviceIdSchema,
    timestamp: z.number().int().nonnegative(),
  })
  .strict();

const ToolCallSchema = z
  .object({
    type: z.literal("tool.call"),
    protocolVersion: ProtocolVersionSchema,
    requestId: RequestIdSchema,
    deviceId: DeviceIdSchema,
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

const ToolResultSchema = z
  .object({
    type: z.literal("tool.result"),
    protocolVersion: ProtocolVersionSchema,
    requestId: RequestIdSchema,
    deviceId: DeviceIdSchema,
    result: z.unknown(),
  })
  .strict();

const ToolErrorSchema = z
  .object({
    type: z.literal("tool.error"),
    protocolVersion: ProtocolVersionSchema,
    requestId: RequestIdSchema,
    deviceId: DeviceIdSchema,
    error: ProtocolErrorEnvelopeSchema,
  })
  .strict();

const ToolCancelSchema = z
  .object({
    type: z.literal("tool.cancel"),
    protocolVersion: ProtocolVersionSchema,
    requestId: RequestIdSchema,
    deviceId: DeviceIdSchema,
  })
  .strict();

const ServerNoticeSchema = z
  .object({
    type: z.literal("server.notice"),
    protocolVersion: ProtocolVersionSchema,
    deviceId: DeviceIdSchema.optional(),
    level: z.enum(["info", "warning", "error"]),
    code: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .strict();

const OperationTimestampSchema = z.number().int().nonnegative();

const OperationPayloadSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      // A metadata-only query may omit an otherwise available response body.
      response: z
        .discriminatedUnion("type", [ToolResultSchema, ToolErrorSchema])
        .optional(),
    })
    .strict(),
  z.object({ status: z.enum(["expired", "evicted", "unavailable"]) }).strict(),
]);

export const OperationSnapshotSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("running"),
    startedAt: OperationTimestampSchema,
    cancelRequested: z.boolean(),
  }).strict(),
  z.object({
    state: z.literal("completed"),
    completedAt: OperationTimestampSchema,
    cancelRequested: z.boolean(),
    outcome: z.enum(["success", "error", "unknown"]),
    payload: OperationPayloadSchema,
  }).strict(),
  z.object({ state: z.literal("not_found") }).strict(),
  z.object({ state: z.literal("restarted") }).strict(),
]);

export const AgentRecoverySchema = z.object({
  type: z.literal("agent.recovery"),
  protocolVersion: ProtocolVersionSchema,
  deviceId: DeviceIdSchema,
  bootId: z.string().uuid(),
}).strict();

export const OperationCallSchema = z.object({
  type: z.literal("operation.call"),
  protocolVersion: ProtocolVersionSchema,
  deviceId: DeviceIdSchema,
  requestId: RequestIdSchema,
  bootId: z.string().uuid(),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  // Admission deadlines are checked against the Agent's clock, not while parsing.
  expiresAt: OperationTimestampSchema,
}).strict();

export const OperationQuerySchema = z.object({
  type: z.literal("operation.query"),
  protocolVersion: ProtocolVersionSchema,
  deviceId: DeviceIdSchema,
  requestId: RequestIdSchema,
  bootId: z.string().uuid(),
  queryId: z.string().uuid(),
  includeResult: z.boolean(),
}).strict();

export const OperationStatusSchema = z
  .object({
    type: z.literal("operation.status"),
    protocolVersion: ProtocolVersionSchema,
    deviceId: DeviceIdSchema,
    requestId: RequestIdSchema,
    bootId: z.string().uuid(),
    queryId: z.string().uuid(),
    snapshot: OperationSnapshotSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (
      message.snapshot.state !== "completed" ||
      message.snapshot.payload.status !== "available"
    ) return;
    const response = message.snapshot.payload.response;
    if (!response) return;
    for (const field of ["deviceId", "requestId"] as const) {
      if (response[field] !== message[field]) {
        context.addIssue({
          code: "custom",
          path: ["snapshot", "payload", "response", field],
          message: `Response ${field} must match the operation status`,
        });
      }
    }
  });

export const RelayMessageSchema = z.discriminatedUnion("type", [
  AgentHelloSchema,
  AgentReadySchema,
  AgentExecutorStatusSchema,
  HeartbeatSchema,
  ToolCallSchema,
  ToolResultSchema,
  ToolErrorSchema,
  ToolCancelSchema,
  ServerNoticeSchema,
  AgentRecoverySchema,
  OperationCallSchema,
  OperationQuerySchema,
  OperationStatusSchema,
]);

export type RelayMessage = z.infer<typeof RelayMessageSchema>;
export type AgentHelloMessage = z.infer<typeof AgentHelloSchema>;
export type ToolCallMessage = z.infer<typeof ToolCallSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultSchema>;
export type ToolErrorMessage = z.infer<typeof ToolErrorSchema>;
export type OperationSnapshot = z.infer<typeof OperationSnapshotSchema>;
export type AgentRecoveryMessage = z.infer<typeof AgentRecoverySchema>;
export type OperationCallMessage = z.infer<typeof OperationCallSchema>;
export type OperationQueryMessage = z.infer<typeof OperationQuerySchema>;
export type OperationStatusMessage = z.infer<typeof OperationStatusSchema>;

export function parseRelayMessage(input: unknown): RelayMessage {
  return RelayMessageSchema.parse(input);
}
