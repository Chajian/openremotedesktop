import { z } from "zod";

export const PROTOCOL_ERROR_CODES = [
  "DEVICE_NOT_FOUND",
  "DEVICE_OFFLINE",
  "DEVICE_NOT_READY",
  "DEVICE_REVOKED",
  "PROTOCOL_INCOMPATIBLE",
  "EXECUTOR_FAILED",
  "REQUEST_TIMEOUT",
  "REQUEST_CANCELLED",
  "EXECUTION_UNKNOWN",
  "TOOL_NOT_SUPPORTED",
  "TOOL_EXECUTION_ERROR",
] as const;

export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const ProtocolErrorEnvelopeSchema = z
  .object({
    code: ProtocolErrorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .strict();

export type ProtocolErrorEnvelope = z.infer<
  typeof ProtocolErrorEnvelopeSchema
>;
