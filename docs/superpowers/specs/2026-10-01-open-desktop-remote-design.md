# Open Desktop Remote — Design Specification

Date: 2026-10-01
Status: Design approved in conversation; written-spec review pending
Working name: Open Desktop Remote
License target: Apache-2.0

## 1. Purpose

Build a fully open-source, self-hostable replacement for the cloud portion of Desktop Commander Remote while preserving the same core working model: an AI client can securely reach one owner's remote computers, select a target device, and invoke Desktop Commander tools there.

The project must not depend on the maintainer's account, servers, approval, or any mandatory third-party SaaS. A technically capable user must be able to clone the repository, deploy the server on their own VPS/domain, pair their own machines, connect ChatGPT or another standards-compatible MCP client, and continue operating even if this project maintainer disappears.

OpenAI or another chosen model provider may receive task data as required by the user's AI workflow. The self-hosted server is part of the trusted computing boundary. The project removes the extra Desktop Commander-operated cloud service from that boundary.

## 2. Primary success criterion

A new user can follow only the repository README and:

1. Deploy one server on Linux with Docker Compose and a public HTTPS domain.
2. Create the single owner account.
3. Install/start the agent on a Windows, macOS, or Linux workstation without opening inbound ports.
4. Pair that workstation through a short browser-confirmed device code flow.
5. Connect ChatGPT through standard remote MCP using OAuth Authorization Code + PKCE.
6. Read and modify a test file through Desktop Commander.
7. Start and continue a shell/process session through Desktop Commander.
8. Pair a second machine and explicitly route calls to either machine.
9. Revoke either machine independently.
10. Complete all of the above without contacting any service operated by this project's maintainer.

## 3. Scope

### In scope for V1

- Single-owner self-hosted deployment.
- Multiple paired devices per owner.
- Standard MCP Streamable HTTP endpoint for AI clients.
- OAuth login for AI clients.
- Device Authorization Grant-style pairing for agents.
- Outbound-only persistent agent connection.
- Device registry, rename, status, revoke, and revoke-all.
- Desktop Commander tool execution through a local stdio child process.
- Windows, macOS, and Linux agent support.
- Linux/Docker server support.
- Minimal web dashboard.
- SQLite persistence.
- Docker Compose reference deployment with Caddy.
- Public and versioned Agent ↔ Server protocol.
- Default metadata-only logs and no third-party telemetry.
- Automated tests plus real-platform smoke tests.

### Explicitly out of scope for V1

- Multi-user or multi-tenant SaaS.
- Team permissions and shared machines.
- Offline command queues.
- Automatic replay of interrupted tool calls.
- Built-in cloud file storage or large-file relay service.
- A custom chat UI or mobile app.
- Mandatory agent auto-update.
- Plugin marketplace.
- General-purpose arbitrary MCP hosting.
- High-availability clustering or horizontal scaling.
- End-to-end encryption that hides payloads from the self-hosted server.
- Reimplementation of Desktop Commander's filesystem/shell/process engine.

## 4. System architecture

The system is split into four independently understandable boundaries:

1. **MCP Gateway** — presents remote MCP to ChatGPT/Claude/Cursor and maps tool requests to a target device.
2. **Auth + Control Plane** — owner login, OAuth, device pairing, device registry, revocation, dashboard, and SQLite state.
3. **Relay Plane** — maintains outbound agent connections and carries versioned tool-call RPC messages.
4. **Agent** — authenticates to the self-hosted server, keeps the relay connection alive, owns the local Desktop Commander stdio process, and bridges relay RPC to MCP stdio.

The server never implements file editing, shell execution, search, process control, PDF handling, or other Desktop Commander business logic. Those remain local to Desktop Commander on the target device.

The Agent does not know or care whether the upstream AI client is ChatGPT, Claude, Cursor, or another MCP client. It only receives normalized relay requests and returns normalized results.

## 5. Repository shape

The implementation will use a TypeScript monorepo:

```
open-desktop-remote/
  apps/
    server/
    agent/
  packages/
    protocol/
    desktop-commander-adapter/
    auth/
    shared/
  docs/
    protocol.md
    self-hosting.md
    security.md
    architecture.md
    superpowers/specs/
  docker/
  docker-compose.yml
  LICENSE
```

The current implementation target is Node.js 24 LTS-compatible TypeScript. Package management will use pnpm workspaces unless implementation research finds a concrete blocker.

## 6. MCP-facing behavior

The server exposes standard MCP over Streamable HTTP.

Desktop Commander tools are presented as first-class MCP tools, not hidden behind a generic `call_tool(name,args)` wrapper. Each remote tool accepts an optional `deviceId` routing argument added by the adapter.

Routing rules:

- If `deviceId` is supplied, route only to that device.
- If no `deviceId` is supplied and exactly one device is READY, select it automatically.
- If no `deviceId` is supplied and more than one device is READY, return a structured selection error containing the available device names and IDs.
- If no device is READY, return a structured DeviceUnavailable error.
- A device must be READY, not merely socket-connected, before tool calls are accepted.

The gateway also exposes control tools such as `list_devices` and `get_device_status`.

## 7. Desktop Commander adapter

V1 reuses Desktop Commander as a local stdio MCP child process.

The agent is responsible for starting, monitoring, and restarting that child process when appropriate. The child process remains alive across temporary server reconnects so local Desktop Commander process/session state is not discarded merely because the network link dropped.

To preserve a good MCP tool-selection experience without reimplementing Desktop Commander tools, the adapter package will ship a generated tool manifest derived from the pinned compatible Desktop Commander version. CI will compare that manifest against the real local `tools/list` response and fail when the pinned version changes incompatibly.

The adapter records and reports the local Desktop Commander version and capabilities during agent readiness negotiation.

## 8. Device state model

Transport connectivity and executor readiness are separate concepts.

Canonical states:

```
OFFLINE
  -> CONNECTED
  -> AUTHENTICATED
  -> EXECUTOR_STARTING
  -> READY
```

Additional transient/error states may include `REVOKED`, `INCOMPATIBLE`, and `EXECUTOR_FAILED`.

Only READY devices accept new tool calls.

The server stores durable identity and last-seen metadata in SQLite. Live socket ownership, outstanding requests, heartbeat timestamps, and transient readiness state stay in memory.

## 9. Agent ↔ Server transport

Agents initiate an outbound WSS connection to the server. A normal deployment therefore requires no inbound workstation port, public IP, router port forwarding, VPN, or SSH exposure.

All public HTTP, OAuth, MCP, dashboard, and relay traffic may share HTTPS port 443 behind the reference reverse proxy.

The Relay is an application protocol, not a raw TCP tunnel. V1 protocol messages include:

- `agent.hello`
- `agent.ready`
- `agent.executor_status`
- `heartbeat`
- `tool.call`
- `tool.result`
- `tool.error`
- `tool.cancel`
- `server.notice`

Every message carries a protocol version. Request/response messages carry a globally unique `requestId`; device-scoped messages carry `deviceId`.

Payload schemas live in `packages/protocol` and are validated on both sides.

## 10. Protocol compatibility

The initial protocol version is `1`.

Handshake includes:

- protocol version range supported by the agent,
- agent version,
- OS/platform,
- Desktop Commander version,
- adapter capabilities,
- device ID,
- server-required minimum protocol version.

If compatibility cannot be negotiated, the server marks the device INCOMPATIBLE and returns a clear upgrade error rather than silently appearing offline.

The protocol is public and documented so third parties may implement their own compatible agents.

## 11. Pairing and device credentials

First-time device pairing uses a standards-inspired Device Authorization flow:

1. Agent requests a temporary device code and human-readable user code.
2. Agent prints the verification URL and short code.
3. The owner signs into the self-hosted dashboard.
4. The owner approves the pending device and may assign a friendly name.
5. The agent polls until approval or expiry.
6. The server issues a device refresh credential.
7. The agent stores the credential in the OS credential store/keychain when available, otherwise in a user-only local file.
8. Short-lived access credentials are derived/refreshed for relay connections.

Server-side long-lived device credentials are stored only as non-reversible verifier material where feasible. Revocation immediately prevents new relay authentication.

## 12. AI-client OAuth

The self-hosted server contains its own authorization server sufficient for a single-owner MCP deployment; Google, GitHub, Auth0, Supabase, Firebase, or another SaaS identity provider is not required.

The MCP client flow is OAuth Authorization Code with PKCE. The server publishes the metadata needed by standards-compatible MCP clients. Dynamic client registration will be supported when required for interoperability.

The dashboard login and OAuth consent flow share the same single-owner identity.

Secrets are generated during bootstrap; production deployment refuses known/default secrets.

## 13. Owner bootstrap

V1 has exactly one owner.

On first deployment, the operator creates the owner through a bootstrap mechanism documented in the README. Bootstrap is disabled after successful initialization unless explicitly reset from the server host.

There is no public user registration endpoint.

## 14. Request delivery semantics

The design prioritizes avoiding accidental duplicate side effects.

The system does **not** claim impossible exactly-once network execution semantics.

Instead:

- Each tool call receives a unique `requestId`.
- The server never automatically replays a dispatched tool call after an ambiguous disconnect.
- The agent keeps a bounded recent-request cache and returns the cached result if it receives the exact same completed `requestId` again.
- If the connection drops after dispatch but before a confirmed result, the server marks the call `EXECUTION_UNKNOWN`.
- The AI/client receives that explicit status and decides whether to inspect state before retrying.
- A reconnect never causes an old shell command, file edit, or process action to be silently executed a second time.

This applies conservatively to all Desktop Commander tools in V1, rather than attempting unreliable read/write classification.

## 15. Cancellation and timeouts

The MCP Gateway assigns a deadline to every relay call.

If the upstream client cancels and the agent is still connected, the server sends `tool.cancel`. Cancellation is best-effort because the underlying OS operation may already have completed.

Timeout does not imply rollback.

Timed-out or ambiguously disconnected mutating operations are reported with enough structured information for the AI to verify resulting state before another attempt.

## 16. Reconnect behavior

The agent reconnects with exponential backoff and jitter.

A relay reconnect does not require repairing the device and does not automatically restart the local Desktop Commander child.

The server treats a reconnected authenticated device as the same device ID.

Outstanding calls are not blindly replayed. Completed cached request IDs may be resolved from the agent cache; unresolved dispatched calls become `EXECUTION_UNKNOWN`.

Heartbeat expiry moves the device out of READY promptly.

## 17. Local executor lifecycle

The Agent supervises one local Desktop Commander stdio process for V1.

Readiness requires:

1. Desktop Commander process successfully started.
2. MCP initialization completed.
3. Tool discovery/capability check completed.
4. Version/manifest compatibility check passed.

If the child process exits unexpectedly, the Agent moves to EXECUTOR_FAILED/EXECUTOR_STARTING and may restart it with bounded backoff. New remote tool calls are rejected until READY.

## 18. Server persistence model

SQLite is the only required database in V1.

Durable tables include at minimum:

- owner/settings,
- OAuth clients and grants needed for MCP interoperability,
- paired devices,
- hashed/verifier device credentials,
- device names and platform metadata,
- revocation state,
- minimal audit metadata configuration.

Transient tool payloads, file contents, screenshots, and shell output are not written to SQLite by default.

## 19. Logging and privacy

Default logs may include:

- timestamp,
- request ID,
- device ID/name,
- tool name,
- duration,
- success/failure,
- structured error class,
- connection/reconnect events.

Default logs must not include tool arguments, file contents, screenshots, shell stdout/stderr bodies, access tokens, refresh credentials, or OAuth authorization codes.

A clearly documented debug-payload logging mode may exist but is off by default and warns that enabling it can expose sensitive work data.

No telemetry is sent to the project maintainer by default. Any future telemetry must be explicit opt-in.

## 20. Security boundary

The self-hosted server is trusted and may see payloads in transit. TLS protects traffic over the network; V1 does not add application-level end-to-end encryption that hides payloads from the server.

The local tool execution authority is the OS account running the Agent/Desktop Commander process.

The project will not claim that Desktop Commander's directory configuration is a complete sandbox. Operators who require a stronger boundary should run the Agent inside a dedicated low-privilege account, VM, or container appropriate to their workload.

Device revoke and owner credential rotation procedures are documented.

## 21. Dashboard

The dashboard is intentionally minimal.

Required screens/actions:

- owner sign-in,
- pending device approval,
- device list,
- friendly device rename,
- state/last-seen/version display,
- individual revoke,
- revoke all,
- MCP connection instructions,
- basic server/version health.

The dashboard is an administration surface, not a separate end-user chat product.

## 22. Deployment

The reference production deployment uses Docker Compose on Linux.

The reference stack contains:

- Open Desktop Remote server,
- persistent SQLite volume,
- Caddy for HTTPS and reverse proxy.

The application itself does not depend on Caddy-specific behavior and documents nginx/Traefik compatibility.

A production deployment exposes only HTTPS/443 publicly. Local development may use localhost HTTP.

Direct non-container server execution remains possible for contributors.

## 23. Agent installation

V1 is developer-oriented and does not require graphical installers.

Target CLI shape:

```
npx <package-name> agent connect --server https://remote.example.com
```

The exact package name is deferred until naming/repository publication.

The terminal process may remain foregrounded in V1. Native daemon/service installation is a later enhancement and is not required for acceptance.

## 24. Large data behavior

The project is not a bulk file-transfer service.

Tool results have configurable size limits. The system should prefer paths, summaries, chunks, or purpose-built file workflows over sending hundreds of megabytes through MCP/model context.

The server does not provide a persistent cloud file cache in V1.

## 25. Concurrency

Multiple MCP clients may connect to the same single-owner server simultaneously.

The relay supports concurrent request IDs and does not globally serialize an entire device.

Conflicting filesystem/process actions are left to the underlying tools/OS semantics. The project may add targeted per-resource controls later if real failures justify them.

## 26. Error taxonomy

Errors returned across the boundary use stable machine-readable codes, including at minimum:

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

Human-readable messages accompany codes but clients must not need to parse message text.

## 27. Testing strategy

Unit tests cover protocol schema validation, routing, device state transitions, credential verification, request deduplication, timeout/cancel behavior, and redaction.

Integration tests run the server against a fake Agent and exercise pairing, READY negotiation, tool calls, disconnects, reconnects, revocation, and ambiguous delivery.

Adapter integration tests launch a real Desktop Commander stdio process and verify the generated tool manifest against live `tools/list`.

End-to-end tests verify MCP client -> server -> relay -> agent -> Desktop Commander -> result.

Release smoke tests run the Agent on Windows, macOS, and Linux. Server reference deployment is tested on Linux Docker.

Security tests confirm unauthenticated MCP/relay access is denied, revoked devices cannot reconnect, secrets are redacted, debug payload logging is off by default, and bootstrap cannot be reused after initialization.

## 28. Open-source and ecosystem contract

The repository contains all code required for:

- server,
- agent,
- relay protocol,
- OAuth/device pairing,
- dashboard,
- database migrations,
- Desktop Commander adapter,
- Docker deployment,
- protocol and self-hosting documentation.

No critical runtime feature may call a maintainer-owned secret service.

The protocol is documented independently of the reference Agent implementation.

V1 uses Apache-2.0, accepting that others may build commercial hosted offerings from the code while preserving license notices and the Apache patent grant.

## 29. Versioning

Server, Agent, and protocol versions are distinct.

The project follows semantic versioning for released packages.

Protocol breaking changes require a protocol-major change and compatibility negotiation. Server updates should preserve at least one previous compatible protocol generation when practical, but V1 does not promise an indefinite compatibility window.

Agent update checks may report a newer version but do not auto-install in V1.

## 30. V1 acceptance checklist

V1 is accepted only when all of the following are demonstrated from a clean environment:

- A user deploys the server from the public repository with no maintainer service dependency.
- HTTPS and owner bootstrap work.
- ChatGPT-compatible remote MCP OAuth succeeds.
- A Windows Agent pairs without inbound ports and reaches READY.
- `list_devices` shows correct state.
- A Desktop Commander file read succeeds.
- A file edit succeeds.
- A persistent shell/process session can be started and continued.
- Temporary network loss reconnects without repairing the device.
- An ambiguous dispatched request is not silently replayed.
- A second device can pair and be targeted explicitly.
- Revoking one device prevents it from reconnecting while the other continues working.
- Default server persistence/logs contain no tool payload bodies.
- Fresh clone + README is sufficient for another technical user to reproduce the system.

## 31. Deferred decisions

The following are intentionally not blockers for V1 design:

- final public project/package name,
- hosted SaaS offering,
- AGPL vs Apache relicensing in a future major version,
- graphical installers,
- background service installers,
- generic arbitrary-MCP adapters,
- plugin marketplace,
- E2E payload encryption,
- multi-owner support,
- HA deployment.

These require separate design decisions rather than being smuggled into the first release.
