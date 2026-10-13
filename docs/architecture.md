# Architecture

## System boundary

Open Desktop Remote is split into a self-hosted Server and one or more workstation Agents.

```text
ChatGPT / MCP client
        |
        | MCP Streamable HTTP + OAuth
        v
Self-hosted Server
  - OAuth / DCR
  - MCP Gateway
  - Device registry
  - Relay router
  - Dashboard
  - SQLite
        ^
        | outbound WSS
        |
Agent on each workstation
  - device credential
  - reconnect/heartbeat
  - request deduplication
  - Desktop Commander stdio bridge
        |
        v
Desktop Commander 0.2.52
  - files
  - shell/processes
  - search
  - document tools
```

## Server responsibilities

The Server owns control-plane and relay concerns:

- single-Owner identity and Dashboard session;
- OAuth Authorization Code + PKCE;
- DCR and OAuth discovery metadata;
- durable device registration and revocation;
- live device connection registry and readiness;
- mapping MCP tool calls to a target READY device;
- request deadlines, cancellation and ambiguous-delivery reporting;
- metadata-only logging by default.

It does not implement Desktop Commander's file, process or document logic.

## Agent responsibilities

The Agent:

1. loads an existing device credential or runs pairing;
2. refreshes a short-lived relay access token;
3. makes an outbound WSS connection to `/relay`;
4. starts a local Desktop Commander stdio MCP process;
5. reports executor readiness;
6. bridges `tool.call` messages to the local MCP process;
7. caches completed request IDs to avoid duplicate execution;
8. reconnects without restarting Desktop Commander after transport-only loss.

The Agent does not know whether the upstream client is ChatGPT, Claude, Cursor or another MCP client.

## State ownership

MCP HTTP is stateless at the application boundary. A ChatGPT MCP request is not a device session.

Durable state in SQLite includes:

- Owner credentials (hashed);
- Dashboard sessions (hashed token verifier);
- OAuth clients/codes/tokens (opaque token hashes);
- device registrations and revocation;
- device refresh credential verifiers;
- durable device metadata such as last seen and versions.

In-memory state includes:

- active WebSocket ownership;
- transient device state;
- pending request promises and deadlines;
- heartbeat timestamps.

Desktop Commander process sessions stay in the Agent/child process, not the Server database.

## Device state

Canonical lifecycle:

```text
OFFLINE
  -> CONNECTED
  -> AUTHENTICATED
  -> EXECUTOR_STARTING
  -> READY
```

A transport-only reconnect may use `AUTHENTICATED -> READY` when the local executor never stopped.

Error/terminal states include `EXECUTOR_FAILED`, `INCOMPATIBLE` and `REVOKED`. Only READY accepts new remote tool calls.

## Tool exposure

The Adapter ships a generated manifest from the pinned Desktop Commander version. The Server registers every manifest entry as a first-class MCP tool and adds one optional routing argument:

```json
{
  "deviceId": "optional stable device UUID"
}
```

The Server strips `deviceId` before forwarding the remaining arguments to Desktop Commander.

Control tools are implemented by Open Desktop Remote itself:

- `list_devices`
- `get_device_status`

## Routing

- Explicit READY `deviceId`: route there.
- Explicit unknown ID: `DEVICE_NOT_FOUND`.
- Explicit known but disconnected ID: `DEVICE_OFFLINE`.
- Explicit connected but not READY: `DEVICE_NOT_READY`.
- No ID + one READY device: auto-select.
- No ID + multiple READY devices: return a structured selection error; never choose randomly.
- No ID + no READY devices: return a structured unavailable error.

## Request delivery

Open Desktop Remote does not claim impossible network-level exactly-once execution.

Each remote call gets a UUID `requestId`.

- If dispatch never happened, a local routing/offline error is returned.
- If dispatch happened and the connection disappears before a result is confirmed, the call becomes `EXECUTION_UNKNOWN`.
- The Server never automatically replays an ambiguous call.
- If the same completed request ID reaches the Agent again, the Agent returns its cached result instead of executing again.

This is deliberately conservative for shell and file mutations.

## Deployment

The reference production topology is one Server container with a persistent `/data` volume and a Caddy container terminating public HTTPS.

Only ports 80/443 are exposed publicly. The internal Fastify port is not published.

V1 does not implement HA, horizontal scaling or multi-owner tenancy.
