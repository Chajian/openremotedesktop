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
]);

export type RelayMessage = z.infer<typeof RelayMessageSchema>;
export type AgentHelloMessage = z.infer<typeof AgentHelloSchema>;
export type ToolCallMessage = z.infer<typeof ToolCallSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultSchema>;
export type ToolErrorMessage = z.infer<typeof ToolErrorSchema>;

export function parseRelayMessage(input: unknown): RelayMessage {
  return RelayMessageSchema.parse(input);
}
