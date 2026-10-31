# Agent guide

The Agent is the workstation-side process. It creates an outbound relay connection and bridges remote calls to a local Desktop Commander stdio process.

## Requirements

- Node.js 24+
- pnpm/Corepack
- Windows, macOS or Linux
- outbound HTTPS/WSS access to the self-hosted Server

No inbound port is required.

## Start

From a source checkout:

```bash
corepack enable
pnpm --filter @open-desktop-remote/agent... install --frozen-lockfile
pnpm --filter @open-desktop-remote/agent start -- \
  agent connect --server https://remote.example.com
```

V1 intentionally does not install itself as a system service. Keep the terminal/process alive, or use your own process supervisor after you understand the security implications.

## First pairing

If no saved credential exists, the Agent requests a temporary pairing and prints:

```text
Open https://remote.example.com/device and approve code ABCD-EFGH
```

Sign into the Dashboard and approve that code.

After approval the Agent receives a long-lived device refresh credential. It prefers the OS credential store and falls back to a user-scoped local file when the native store is unavailable.

The Server stores only verifier/hash material for the long-lived credential.

## Connection lifecycle

The Agent:

1. refreshes a short-lived device access token;
2. opens `wss://<server>/relay`;
3. sends `agent.hello`;
4. starts or reuses Desktop Commander;
5. reports executor readiness;
6. sends heartbeat messages;
7. handles tool calls until stopped or disconnected.

Reconnect uses exponential backoff with jitter. A network-only reconnect leaves the local Desktop Commander process alive, preserving its interactive process/session state.

A local MCP operation that remains unsettled for 10 minutes triggers a *local executor
recycle* to recover capacity. The Agent records its running operations as
`EXECUTION_UNKNOWN` before replacing the executor and never replays them.
This can interrupt legitimately slow local operations and does not undo effects
already produced. The Server transitions from `EXECUTOR_FAILED` to
`EXECUTOR_STARTING` and then `READY`. The STARTING event is sent only after
the old process closes.
If shutdown cannot be confirmed, the Server remains `EXECUTOR_FAILED` and an
operator must resolve the failure rather than launch another local executor.
Ordinary network-only reconnects do not recycle the executor.
The hard deadline can be adjusted in `RelayClientOptions.stalledOperationTimeoutMs`.

For negotiated `operation.call` execution, the Agent passes an explicit timeout
to the local Desktop Commander MCP SDK: **watchdog deadline + 30 seconds**
(default **10 minutes 30 seconds**). Both the SDK request timeout and its
maximum total timeout use that value. This prevents the SDK's usual 60-second
request timeout from marking a hung, still-connected execution as complete
before the 10-minute recovery watchdog can run. The watchdog remains the
authority for recycling a stalled executor; the operation stays
`EXECUTION_UNKNOWN` and is never replayed. An ordinary tool `isError` result
is a completed business failure, not an executor failure. Legacy calls that do
not negotiate operation recovery still use their existing SDK timeout behavior.

Retryable network, relay WebSocket handshake and token-refresh transport failures use this
backoff. Rejected credentials and incompatible protocol remain terminal. Reconnect
does not resend a previously dispatched tool call.

Token refresh validates the access token, expiry value and device identity before
opening the Relay connection. A successful HTTP response containing invalid JSON
or an invalid token payload is a terminal server-response error, not a credential
rejection or a retryable network failure. The CLI reports an invalid server
response without printing the response body or token values; saved credentials
remain unchanged. HTTP 401/403 still reject credentials, including when their
error body is malformed. Network I/O failures retain the existing retry policy.

A local MCP initialization refusal, unexpected subprocess exit or tool-discovery
failure ends startup with an error after owned cleanup. It does not leave the
Agent sending heartbeats with an unusable executor or automatically retry the
failed initialization. Runtime callers retain the original startup error when
available; the CLI prints a sanitized diagnostic and exits unsuccessfully.

## Stopping

Press Ctrl+C in the Agent terminal to stop it. The stop signal cancels pending
pairing requests and polling waits, token refresh (including an unfinished
response body), WebSocket establishment and local MCP initialization. Relay closes
its owned socket, and runtime waits for the executor's existing cleanup result.
An unresponsive relay peer cannot hold shutdown open by withholding a WebSocket
close reply. Saved credentials remain available for the next start.

In temporary support mode, wait for the remote-access revocation confirmation
before closing the terminal. Repeated Ctrl+C/SIGTERM during cleanup does not
interrupt the revoke request. If revocation cannot be confirmed, ask the session
creator to end support in Dashboard. Killing the process or closing its window
can still prevent cleanup; a disconnected device alone is not proof of revocation.

Stopping does not undo effects of an already dispatched tool call. Unknown
execution outcomes remain unknown and are never automatically replayed. An
unconfirmed executor shutdown remains an error and prevents an unsafe replacement.

## Desktop Commander

V1 pins `@wonderwhy-er/desktop-commander@0.3.1`.

The Adapter resolves the installed package entry point and starts the ordinary local stdio MCP mode with `--no-onboarding`. It does not use Desktop Commander's official Remote mode.

Compatibility is gated by a generated 25-tool manifest and live stdio integration tests.

The runtime checks the subprocess-reported version and exact tool names plus
input/output schemas before READY. A nonempty but incomplete catalog is rejected
and its subprocess is closed. Reinstall the matching Agent package if its pinned
dependency or generated contract has drifted. An initialization error or a
protocol-incompatibility notice retains the cleanup handle; failed shutdown
blocks a replacement process until cleanup succeeds.

Server updates continue to accept installed 0.2.52 Agents for the common 25-tool
catalog. `get_prompts` was removed in 0.3.1, so clients with a cached catalog must
refresh `tools/list`. Search context/limit/timeout arguments require nonnegative
integers, pagination length requires a positive integer, and negative integer
pagination offsets remain supported. Public shell guidance is device-neutral;
query the selected device's `get_config` for its actual default shell.

Both existing three-OS CI matrices run the real adapter lifecycle and file/PDF/
search/process regression suite. Native execution evidence is still required
for platform acceptance; platform-description fixtures alone are not a native
Windows or macOS result. Upstream malformed-PDF responses currently include an
error diagnostic in text without `isError: true`; the proxy preserves that
upstream result and tests subsequent process availability.

The generated catalog lives in the pure `tool-contracts` workspace package. The
Agent still launches the original pinned upstream package through the same local
stdio adapter; operation recovery is implemented entirely in OpenRemote code.

## Credential reset

Server-side: revoke the device in the Dashboard.

Client-side: remove the Agent's saved Open Desktop Remote credential from the OS credential store or its fallback file, then start the Agent again to trigger pairing.

The exact fallback file location is platform/user-profile dependent; inspect the credential-store implementation when doing manual recovery rather than copying another user's path.

## States

- `OFFLINE`: no active relay connection
- `CONNECTED`: transport attached
- `AUTHENTICATED`: device token accepted
- `EXECUTOR_STARTING`: Desktop Commander is being initialized/checked
- `READY`: tool calls accepted
- `EXECUTOR_FAILED`: local executor unavailable
- `INCOMPATIBLE`: protocol/tool compatibility failed
- `REVOKED`: device no longer authorized

A healthy transport is not enough: only READY receives tools.

## Troubleshooting

### Pairing repeats every start

The credential store is unavailable/unwritable or the Server rejected/revoked the saved credential. Check the native credential backend and user-profile permissions.

### Connected but not READY

Inspect Agent output for Desktop Commander startup or manifest/version compatibility errors.

### Repeated disconnects

Verify HTTPS/WSS reachability, reverse-proxy support for WebSocket upgrades, system clock sanity and Server health.

### `EXECUTION_UNKNOWN`

The result could not be confirmed after dispatch. The error includes an
`operationId`. A dispatched `REQUEST_TIMEOUT` with an operation ID is also
ambiguous: the Server ends its waiter after at most 45 seconds (below the MCP
SDK client's 60-second default), but the Agent's command can still be running.
When `recovery` is true, use `odr_get_operation` from the same authorized MCP
client with that ID; this reads the existing operation and never repeats the
tool call. `includeResult: false` requests metadata only.

Keep the Agent process alive while recovering. Its process identity and result
cache survive relay reconnects; an Agent restart cannot recover old result bodies.
Results are queryable for up to 15 minutes after completion, within a 64 MiB total
cache and 8 MiB per-response limit. Capacity pressure can evict a body earlier.
The Server keeps metadata for 24 hours, so a known completion may remain visible
after its body expires. Queries do not extend either retention period.

`running` means execution has not produced a terminal observation. `restarted`,
`not_found`, `expired`, `evicted` or `unavailable` does not mean the effect did not
occur. Check actual machine state before deciding to submit a new mutation.
Older peers continue working with legacy calls, but do not gain this recovery path.

## Stopping

Ctrl+C / SIGTERM aborts the relay loop and closes the local Desktop Commander client.

A `REQUEST_TIMEOUT` with `details.dispatched: false` and a capacity reason is
rejected *before* sending any command; it has no recoverable operation ID.
A Server metadata-storage fault is not treated as a malformed Relay message:
an already-correlated response can still be delivered, but stored evidence
may be incomplete until a later read-only query reconciles it.
