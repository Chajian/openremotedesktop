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

Retryable network/handshake and token-refresh transport failures also use this
backoff. Rejected credentials and incompatible protocol remain terminal. Reconnect
does not resend a previously dispatched tool call.

## Desktop Commander

V1 pins `@wonderwhy-er/desktop-commander@0.2.52`.

The Adapter resolves the installed package entry point and starts the ordinary local stdio MCP mode with `--no-onboarding`. It does not use Desktop Commander's official Remote mode.

Compatibility is gated by a generated 26-tool manifest and live stdio integration tests.

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
`operationId`. When `recovery` is true, use `odr_get_operation` from the same
authorized MCP client with that ID; this reads the existing operation and never
repeats the tool call. `includeResult: false` requests metadata only.

Keep the Agent process alive while recovering. Its process identity and result
cache survive relay reconnects; an Agent restart cannot recover old result bodies.
Results are retained for up to 15 minutes after completion, within a 64 MiB total
cache and 8 MiB per-response limit. Capacity pressure can evict a body earlier.
The Server keeps metadata for 24 hours, so a known completion may remain visible
after its body expires. Queries do not extend either retention period.

`running` means execution has not produced a terminal observation. `restarted`,
`not_found`, `expired`, `evicted` or `unavailable` does not mean the effect did not
occur. Check actual machine state before deciding to submit a new mutation.
Older peers continue working with legacy calls, but do not gain this recovery path.

## Stopping

Ctrl+C / SIGTERM aborts the relay loop and closes the local Desktop Commander client.
