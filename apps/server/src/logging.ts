import { redactSensitive } from "@open-desktop-remote/shared";

export type StructuredLogRecord = Record<string, unknown>;
export type LogSink = (record: StructuredLogRecord) => void;

export type ServerLogger = {
  event(event: string, metadata?: Record<string, unknown>): void;
  payload(
    event: string,
    metadata: Record<string, unknown>,
    payload: unknown,
  ): void;
};

export function createServerLogger(
  options: {
    env?: Record<string, string | undefined>;
    sink?: LogSink;
    warn?: (message: string) => void;
  } = {},
): ServerLogger {
  const env = options.env ?? process.env;
  const sink =
    options.sink ??
    ((record: StructuredLogRecord) => console.log(JSON.stringify(record)));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const debugPayloadLogging = env.DEBUG_PAYLOAD_LOGGING === "true";

  if (debugPayloadLogging) {
    warn(
      "DEBUG_PAYLOAD_LOGGING is enabled: logs may contain sensitive tool payloads.",
    );
  }

  return {
    event(event, metadata = {}) {
      sink(
        redactSensitive({
          component: "server",
          event,
          ...metadata,
        }) as StructuredLogRecord,
      );
    },
    payload(event, metadata, payload) {
      if (!debugPayloadLogging) return;
      sink({
        component: "server",
        event,
        ...metadata,
        payload,
      });
    },
  };
}

/** Maintenance runs opportunistically: reporting failures must never crash a request or timer. */
export function logMaintenanceFailure(
  logger: Pick<ServerLogger, "event"> | undefined,
  event: "operation.cleanup_failed" | "relay.sweep_failed" | "device_deletion_audit.cleanup_failed",
  error: unknown,
): void {
  // Report only recognized machine-readable SQLite codes, never raw SQL,
  // exception messages, operation arguments or potentially sensitive paths.
  try {
    const candidate = error !== null && typeof error === "object" && "code" in error
      ? error.code : undefined;
    const code = typeof candidate === "string" && /^SQLITE_[A-Z0-9_]{1,40}$/.test(candidate)
      ? candidate : undefined;
    logger?.event(event, code ? { code } : {});
  } catch {
    // Even the logging sink can fail; maintenance must not become fatal.
  }
}
