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

## Desktop Commander

V1 pins `@wonderwhy-er/desktop-commander@0.2.52`.

The Adapter resolves the installed package entry point and starts the ordinary local stdio MCP mode with `--no-onboarding`. It does not use Desktop Commander's official Remote mode.

Compatibility is gated by a generated 26-tool manifest and live stdio integration tests.

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

The connection disappeared after the Server dispatched a call. Do not automatically repeat a destructive command; inspect machine state first.

## Stopping

Ctrl+C / SIGTERM aborts the relay loop and closes the local Desktop Commander client.
