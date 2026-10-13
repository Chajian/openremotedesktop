import { redactSensitive } from "@open-desktop-remote/shared";

export type AgentLogRecord = Record<string, unknown>;
export type AgentLogSink = (record: AgentLogRecord) => void;

export type AgentLogger = {
  event(event: string, metadata?: Record<string, unknown>): void;
  payload(
    event: string,
    metadata: Record<string, unknown>,
    payload: unknown,
  ): void;
};

export function createAgentLogger(
  options: {
    env?: Record<string, string | undefined>;
    sink?: AgentLogSink;
    warn?: (message: string) => void;
  } = {},
): AgentLogger {
  const env = options.env ?? process.env;
  const sink =
    options.sink ??
    ((record: AgentLogRecord) => console.log(JSON.stringify(record)));
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
          component: "agent",
          event,
          ...metadata,
        }) as AgentLogRecord,
      );
    },
    payload(event, metadata, payload) {
      if (!debugPayloadLogging) return;
      sink({
        component: "agent",
        event,
        ...metadata,
        payload,
      });
    },
  };
}
