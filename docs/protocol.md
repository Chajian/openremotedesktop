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
- `agentVersion`: the Agent release version, shared with the published npm package version
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

## Negotiated operation recovery

Recovery is an additive v1 capability. Existing message shapes remain unchanged.
Each connection negotiates independently:

1. Agent includes `operation-recovery-v1` in `agent.hello.capabilities`.
2. Server sends the existing `server.notice` shape with code `OPERATION_RECOVERY_ENABLED`.
3. Agent replies with `agent.recovery`, carrying `deviceId` and a UUID `bootId`.
4. Server enables recovery only after that reply. Before agreement, or with an old peer, calls use the original `tool.call` shape.

`bootId` identifies the Agent process and survives WebSocket reconnection. An Agent restart changes it. Replacing the local executor makes running operations unknown; already completed cached results remain readable.

| Frame | Direction | Fields in addition to `protocolVersion` and `deviceId` |
| --- | --- | --- |
| `agent.recovery` | Agent → Server | `bootId` |
| `operation.call` | Server → Agent | `requestId`, `bootId`, `toolName`, `arguments`, `expiresAt` |
| `operation.query` | Server → Agent | `queryId`, `requestId`, expected `bootId`, `includeResult` |
| `operation.status` | Agent → Server | `queryId`, `requestId`, responding `bootId`, `snapshot` |

The stable operation ID is the existing `requestId`; queries have separate UUIDs.
Completion still uses `tool.result` or `tool.error`. An embedded response in a
status must match both the surrounding request and device IDs. Status replies
are matched to the current authenticated socket and outstanding query; old
sockets cannot complete a newer connection's request.

Snapshots use `state: running | completed | not_found | restarted`.
Running snapshots contain `startedAt` and `cancelRequested`. Completed snapshots
contain `completedAt`, `cancelRequested`, an `outcome` of `success | error | unknown`,
and a payload availability of `available | expired | evicted | unavailable`.
An available payload contains the original response when `includeResult` is true;
metadata-only queries omit that body. Unknown, missing or restarted observations
never establish that an operation did not execute.

Submission expiry is an admission deadline, not an execution timeout. Server
sets it to now + 60 seconds; Agent rejects expired deadlines and deadlines more
than five minutes ahead. Its admission clock cannot move backwards within the
process. A canonical in-memory intent binds the ID to device, boot, tool,
arguments and expiry; changed intent under the same ID is rejected. Server never
resends a submission to recover a result.

Agent defaults are 32 in-flight operations, 10,000 metadata records, 64 MiB cached
response bodies, 8 MiB per serialized response, and 15 minutes of result retention
after completion. Expiry is enforced during admission, completion and query;
idle entries are reclaimed on the next such access. Capacity pressure may evict
bodies sooner, with explicit
`evicted` availability. Metadata survives until both admission expiry and outcome
retention have ended. Querying does not extend retention or execute a tool.

The Server retains metadata for 24 hours and keeps at most 1,024 call waiters and
64 recovery-query waiters. Queries time out after five seconds. A timeout or
disconnect ends the original waiter but leaves the operation ID usable for a
later query. Late valid terminal evidence is retained; contradictory terminal
responses are marked as conflicts and their bodies are withheld.

The MCP SDK client's default request timeout is **60 seconds**. The Server caps
the original tool-call **waiter** at **45 seconds**, counting tool routing
and operation-policy authorization after the handler begins. Both layers use
Node's monotonic `performance.now()` to track elapsed time and the shared
deadline, so a system wall-clock adjustment cannot extend the original budget.
This reserves up to 15 seconds for the initial HTTP auth, response delivery
and other overhead under the SDK's default deadline. A configured longer waiter is capped to the
same limit. If this budget is exhausted before any dispatch, the Server rejects with
`REQUEST_TIMEOUT`, `details.dispatched: false`, and no operation ID.
After dispatch, a waiter timeout retains `details.operationId` for read-only
recovery. A shorter Server waiter does **not** cancel or retry the local effect.
The Agent's default 10-minute stalled-executor watchdog is separate from both
this waiter and the 60-second **submission admission** expiry described above.
The Agent also overrides the **local Desktop Commander MCP SDK** request timeout
for negotiated recovery operations to **watchdog + 30 seconds** (default 630 s),
including its maximum total timeout. Thus the SDK's unrelated default 60 s
timeout cannot clear the 10-minute watchdog while a local stdio connection
remains open but the tool fails to respond. A watchdog recycle marks the original
operation unknown, never resends it, and only starts a new executor after
the old process has been safely closed. Ordinary tool-level `isError` responses
are completed operations, not a watchdog restart signal. Legacy tool calls
outside negotiated recovery keep their previous local SDK timeout behavior.
Other clients and reverse proxies with shorter request timeouts may still need
their own configuration.

Background metadata pruning (once per minute) and the stale-heartbeat sweep
are best-effort: exceptions emit `operation.cleanup_failed` or
`relay.sweep_failed` without escaping the timer or preventing later ticks.
Opportunistic pruning failure also does not block authorized dispatch or a
read-only query. Genuine operation create/read/update database errors still
surface normally; this is not a blanket SQLite-error suppression. During a
stale sweep, a socket that fails to terminate is retained for a later attempt,
while other stale sockets continue to be processed. Failure telemetry includes
only approved machine-readable codes, not raw SQL or local paths.

Cancellation records a request to stop, independently of actual completion.
It does not erase a successful outcome or promise rollback. An executor exception,
serialization failure or oversized response can leave execution unknown even if
a local effect already occurred.

## MCP recovery tool

OpenRemote registers `odr_get_operation({ operationId, includeResult? })` separately
from the upstream catalog. `includeResult` defaults to true. Original ambiguity
and timeout responses include `structuredContent.error.details.operationId` and
a `recovery` capability flag.

The query returns `structuredContent.operation` with durable phase/outcome,
`resultAvailability`, `cancelRequested`, and a snapshot when available. Availability
also reports `offline`, `legacy`, `restarted`, `not_found`, `timeout`, `conflict`, or
`running`. A query-capacity rejection is `unavailable` with `reason: capacity`.
Missing and inaccessible operations both return `{ state: "not_found" }`.
Access requires the original user and OAuth client, current device ownership,
and current authorization. Authorization is checked again before result delivery.
The MCP text content is a compact metadata summary; the cached response body is
included only in `structuredContent.operation`, avoiding a second copy in text.

The default serialized result limit is 8 MiB. Oversize results return a structured error rather than forwarding the full payload; recovery-capable operations preserve the fact that execution may already have occurred.

## Security properties

- Relay access token must belong to the same `deviceId` carried in messages.
- Agent-originated calls, queries, cancellation frames or Server notices are rejected as wrong-direction messages. Unnegotiated recovery frames are rejected.
- Invalid JSON/schema messages close the relay connection.
- Revoked devices cannot authenticate a new relay connection.
- All payload transport is expected to be protected by HTTPS/WSS in production.

The self-hosted Server is trusted; the relay protocol does not add payload encryption that hides data from the Server.
