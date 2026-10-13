# Agent ↔ Server Relay Protocol

Protocol version: **1**

Transport: outbound WebSocket from Agent to Server at `/relay`, protected by a short-lived device Bearer token.

Every message is strict JSON and carries `protocolVersion: 1`. Device-scoped messages carry the immutable UUID `deviceId`. Tool request/response messages carry a UUID `requestId`.

The runtime schemas are authoritative and live in `packages/protocol/src/messages.ts`.

## Handshake and readiness messages

### `agent.hello`

Sent by the Agent after relay authentication.

Fields include:

- `deviceId`
- `agentVersion`
- `protocolRange: { min, max }`
- `platform`: `win32 | darwin | linux`
- `desktopCommanderVersion`
- `capabilities`

The Server records durable runtime metadata and validates protocol compatibility.

### `agent.executor_status`

Reports local executor transitions such as:

- `EXECUTOR_STARTING`
- `READY`
- `EXECUTOR_FAILED`
- `INCOMPATIBLE`

### `agent.ready`

States that the local Desktop Commander MCP process is initialized, tool discovery/compatibility passed, and the device may receive tool calls.

A reconnect may reassert READY directly after authentication when the local executor survived the network loss.

### `heartbeat`

Contains `deviceId` and a timestamp. The Agent normally sends heartbeats every 15 seconds; the Server treats a connection as stale after 45 seconds without valid heartbeat activity.

## Tool messages

### `tool.call`

Server → Agent.

```json
{
  "type": "tool.call",
  "protocolVersion": 1,
  "requestId": "uuid",
  "deviceId": "uuid",
  "toolName": "read_file",
  "arguments": {}
}
```

### `tool.result`

Agent → Server. `result` is the unmodified serializable result from local Desktop Commander.

### `tool.error`

Agent → Server. Carries a stable error envelope:

```json
{
  "code": "TOOL_EXECUTION_ERROR",
  "message": "human readable message",
  "details": {}
}
```

### `tool.cancel`

Server → Agent. Cancellation is best-effort. It never implies rollback of an OS operation that already completed.

## `server.notice`

Server → Agent informational/warning/error notice. It is not a tool result and cannot be sent in the Agent→Server direction.

## Stable error codes

V1 defines:

- `DEVICE_NOT_FOUND`
- `DEVICE_OFFLINE`
- `DEVICE_NOT_READY`
- `DEVICE_REVOKED`
- `PROTOCOL_INCOMPATIBLE`
- `EXECUTOR_FAILED`
- `REQUEST_TIMEOUT`
- `REQUEST_CANCELLED`
- `EXECUTION_UNKNOWN`
- `TOOL_NOT_SUPPORTED`
- `TOOL_EXECUTION_ERROR`

Clients should branch on the code, not parse the message text.

## Version negotiation

An Agent advertises a supported protocol range. Server and Agent choose the highest common version.

If the ranges do not overlap, the device enters `INCOMPATIBLE` and does not receive tool calls. Invalid ranges are rejected.

Protocol changes that break wire compatibility require a new protocol major version.

## Delivery semantics

The Server tracks an outbound request from creation through dispatch.

A connection loss after a request is dispatched but before result confirmation produces `EXECUTION_UNKNOWN`; the Server must not replay that request on the next connection.

The Agent maintains a bounded completed-request cache. Receiving an already completed `requestId` returns the cached message without executing Desktop Commander again.

The default serialized result limit is 8 MiB. Oversize results return a structured execution error rather than forwarding the full payload.

## Security properties

- Relay access token must belong to the same `deviceId` carried in messages.
- Agent-originated `tool.call`, `tool.cancel`, or `server.notice` are rejected as wrong-direction messages.
- Invalid JSON/schema messages close the relay connection.
- Revoked devices cannot authenticate a new relay connection.
- All payload transport is expected to be protected by HTTPS/WSS in production.

The self-hosted Server is trusted; the relay protocol does not add payload encryption that hides data from the Server.
