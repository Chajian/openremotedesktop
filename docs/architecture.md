# Architecture

## Scope: current source, not a production receipt

This document describes the current repository implementation, including legacy local Owner compatibility **and** GitHub-backed accounts with user-scoped devices and MCP authorization. Earlier V1 single-Owner text was historical and must not be treated as a current feature limit. GitHub sign-in is conditional on configured OAuth credentials; this is not an organization/role administration system.

For public-domain and production-specific constraints, see [dual-domain rollout](dual-domain-github-mcp.zh-CN.md). A passing source test or an updated document does not prove that a particular VPS image or Agent binary was deployed. Verify the deployed image and existing Dashboard before upgrading it.

## System boundary

Open Desktop Remote is split into a self-hosted Server and one or more workstation Agents.

```text
ChatGPT / MCP client
        |
        | MCP Streamable HTTP + OAuth
        v
Self-hosted Server
  - OAuth / DCR and GitHub/legacy Owner login
  - MCP Gateway
  - Per-user device registry
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

- legacy password-based local Owner and optional GitHub-based account login, with scoped Dashboard sessions;
- OAuth Authorization Code + PKCE;
- DCR and OAuth discovery metadata;
- durable per-user device registration, ownership-scoped listing/routing and revocation;
- live device connection registry and readiness;
- validating MCP client approval, resource-bound access tokens and user ownership before routing calls to a target READY device;
- request deadlines, cancellation and ambiguous-delivery reporting;
- metadata-only operation records and authorized, read-only result recovery;
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

- local Owner password hashes and GitHub identity mappings (not GitHub access tokens);
- per-account Dashboard sessions (hashed token verifier);
- OAuth client registrations, per-user approvals, codes and tokens (opaque token hashes);
- per-user device registrations and revocation;
- device refresh credential verifiers;
- durable device metadata such as last seen and versions.
- operation actor/client/device identity, process epoch, timestamps, terminal classification and a response digest for conflict detection; never arguments or result bodies.

In-memory state includes:

- active WebSocket ownership;
- transient device state;
- pending request promises and deadlines;
- heartbeat timestamps.

Agent memory separately owns bounded operation records and cached response bodies.
The Server's `OperationService` handles authorization and evidence; its repository
uses the existing SQLite database. `RequestBroker` handles temporary waiters and
wire correlation. An `OperationAccessPolicy` interface currently has an owned-only
implementation, leaving a narrow extension point for future sharing rules without
adding sharing in this change.

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

The pure `packages/tool-contracts/` package ships a generated manifest from the pinned Desktop Commander version. It has no runtime executor dependency. The Server registers every manifest entry as a first-class MCP tool and adds one optional routing argument:

```json
{
  "deviceId": "optional stable device UUID"
}
```

The Server strips `deviceId` before forwarding the remaining arguments to Desktop Commander.

Control tools are implemented by Open Desktop Remote itself:

- `list_devices`
- `get_device_status`
- `odr_get_operation`

The runtime adapter remains on the Agent side and re-exports catalog helpers for
source compatibility. The Server production dependency closure excludes both the
adapter and Desktop Commander. Agent packaging leaves the original pinned npm
package external; all tool execution continues through the existing local MCP
stdio client. Neither upstream Desktop Commander project is modified or forked.

## Routing

The Server first narrows visible device records and MCP grants to the authenticated account. An explicit device ID belonging to another user is treated as not found; being READY does not grant cross-user access.

- Explicit authorized READY `deviceId`: route there.
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

Recovery-capable peers negotiate `operation-recovery-v1` per WebSocket connection.
After an ambiguous call, the original OAuth client can query the returned
operation ID. The Agent reads its existing record and optionally returns the
original cached response. The query component receives only a read-store
interface, with no executor or submission capability. Sending a query cannot
create or repeat an operation.

The guarantee depends on the Agent process surviving and its bounded result cache
still retaining the body. Agent restart, expiry, eviction and unavailable results
are explicit states. Server metadata survives Server restart but contains no
payload backup. This is not durable job execution or a network exactly-once claim.
Limits, negotiation and the MCP response contract are in [protocol](protocol.md).

`pnpm upstream:check` verifies the pinned original dependency identity,
upstream-targeted patch/deep-implementation references, and all 249 original
published package files against a hash baseline derived from the
integrity-verified npm tarball. CI repeats the installed-file check after tests
and packaged smoke. OpenRemote's own launcher and unrelated build hooks remain
editable with normal reviews and tests; they are not upstream source.
Build metadata checks that the upstream implementation remains external. These
checks provide reviewed boundary evidence; they are not a general sandbox for
arbitrary dependency behavior. A future upstream upgrade must deliberately update
the pin, generated contracts, compatibility evidence and reviewed hash baseline.

## Deployment and compatibility

The repository's sample `docker-compose.yml` documents a self-hosted Server with durable `/data` and Caddy providing public HTTPS; Fastify should remain private, with only HTTPS ingress exposed. **This is a reference topology, not the current VPS deployment recipe.**

The existing deployment runbook describes a VPS/Nginx stack and persistent Server/database state; the exact running topology must be verified separately. Before a production update, inventory the running image and Dashboard routes, retain the current SQLite data with a verified backup/restore path, and compare the actual deployed UI with the candidate. Do not blindly replace the VPS stack with the repository's sample Caddy Compose. See [dual-domain production baseline and rollback](dual-domain-github-mcp.zh-CN.md).

For multi-domain MCP access, each trusted HTTPS origin has its own resource audience; the established OAuth issuer and previously authorized clients/devices must continue to work. New origins must be explicitly configured and validated, with independent browser cookies and no cross-resource bearer-token replay.

The repository implements legacy Owner and separate GitHub-backed users with per-account device/MCP isolation. This **does not imply** organization administration, shared devices, high availability or horizontal Server scaling; those remain out of scope unless independently specified and tested.
