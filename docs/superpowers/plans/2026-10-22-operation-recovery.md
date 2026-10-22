# Operation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover a completed remote operation after a relay disconnect without executing it again or modifying upstream Desktop Commander.

**Architecture:** Keep the existing Server/SQLite/Agent/stdio architecture. Add stable operation metadata and a negotiated read-only recovery channel; separate temporary waiters from execution and result retention. Isolate the pure tool catalog from the runtime adapter.

**Tech Stack:** Node.js >=24, pinned pnpm 10.12.3, TypeScript, Zod, Fastify/ws, existing better-sqlite3 and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-operation-recovery-design.md`

## Global Constraints

- Both upstream projects and @wonderwhy-er/desktop-commander@0.2.52 remain unchanged.
- Keep packages/desktop-commander-adapter/src/desktop-commander-client.ts byte-identical in this change.
- No automatic re-execution; read-only query never owns an executor or submit capability.
- No default persistence/logging of tool arguments or result bodies; Server SQLite holds metadata only.
- Keep protocolVersion 1 and every existing v1 message shape unchanged.
- Recovery messages require capability negotiation per connection; old peers retain legacy behavior.
- Defaults: 32 in-flight operations, 10,000 metadata entries, 64 MiB cached result bodies, 8 MiB per result, and 15 minutes result retention from completion.
- Submit expiry: Server now + 60 seconds, Agent rejects expired or over-five-minute future deadlines using a non-decreasing process clock.
- Query timeout is 5 seconds and at most 64 simultaneous queries per Server; metadata retention is 24 hours.
- Only operate in the isolated branch; preserve unrelated work. No merge, push, publish or production deployment.

## Review Focus

- A stale socket's result/query response must not mutate or complete a newer connection's request (Tasks 2 and 3).
- A missing cache entry after TTL or bootId change must never acquire execution rights (Tasks 1 and 2).
- Original invocation or query authorization can be revoked during an await; delivery rechecks current access (Task 3).
- Same operation ID with changed arguments and conflicting terminal replies must not silently reuse/overwrite a result (Tasks 2 and 3).
- Frozen lock identity alone does not detect scripts modifying installed upstream files; inspect package files after build/test (Task 4).

## Task 1: Compatible recovery contracts

**Files:** modify `packages/protocol/src/messages.ts`, `index.ts`; create `recovery.ts` and `recovery.test.ts`; extend messages tests.

**Interfaces:** export OPERATION_RECOVERY_CAPABILITY, OPERATION_RECOVERY_NOTICE, OperationSnapshotSchema/OperationSnapshot, AgentRecoveryMessage, OperationCallMessage, OperationQueryMessage, OperationStatusMessage. Extend RelayMessage and parseRelayMessage without altering old shapes. Constants and exact wire fields are defined in the spec.

- [ ] Write failing tests for all new frames, result ID mismatch, unknown/extra fields, invalid UUID/expiry, old v1 fixtures unchanged, and completed payload variants.
- [ ] Run `pnpm --filter @open-desktop-remote/protocol test:run` and record the intended failure.
- [ ] Implement strict schemas and exported types/constants, keeping existing errors compatible.
- [ ] Run protocol tests and typecheck; review the contract before downstream integration.

## Task 2: Agent operation records and query path

**Files:** `apps/agent/src/requests/operation-store.ts`, `operation-query.ts`, their tests; existing `tool-dispatcher.ts`/tests, `relay/relay-client.ts`/tests, and executor lifecycle hooks only if necessary.

**Interfaces:** consumes Task 1 wire types. Provide a read-only `OperationReadStore` and `OperationQuery` that return OperationSnapshot for requestId/expectedBootId/includeResult. Agent coordinator accepts OperationCallMessage and produces existing ToolResultMessage/ToolErrorMessage. Expose a stable process bootId and use the existing ExecutorClient/ExecutorManager callTool interface; no upstream imports.

- [ ] Write red tests for exactly one effect across disconnect/query, canonical fingerprint conflict, boot mismatch, expired/future submission, backward clock, bounded in-flight/bytes/metadata, payload expiry/eviction with preserved metadata, and cancellation that preserves actual completion.
- [ ] Implement in-memory operation records, deterministic cleanup/admission, and a read-only query object whose dependencies cannot execute.
- [ ] Implement per-connection capability negotiation, agent.recovery announcement, operation.call/query direction checks, and result sending through the current session after saving the result.
- [ ] Preserve old-peer tool.call semantics and contain failed sends; maintain results across same-process reconnection. Executor replacement invalidates running observations.
- [ ] Run Agent tests/typecheck. Include old-Server/new-Agent fallback and reject unnegotiated recovery messages.

## Task 3: Server metadata, recovery transport and MCP control tool

**Files:** new `apps/server/src/operations/` repository/service/access-policy and tests; `db/migrations.ts` and database tests; `relay/request-broker.ts`, `connection-registry.ts`, `relay-route.ts` and tests; `mcp/register-desktop-tools.ts`, optional small dedicated control-tool module, app wiring, relevant MCP tests.

**Interfaces:** consumes Task 1 frames; preserve existing RequestBroker call(deviceId,toolName,args,{timeoutMs}) API for legacy call sites. Add a narrow recovery transport API for querying a requestId on a specified negotiated bootId, bound to exact socket and queryId. OperationService accepts actor context (userId/clientId plus current authorization), creates metadata before dispatch, and provides invoke/query. Query MCP tool is `odr_get_operation({operationId, includeResult?:boolean})`. Task 4 will switch Server catalog imports/dependency to `@open-desktop-remote/tool-contracts`; do not edit package manifests in this task.

- [ ] Write red tests for metadata migration/reopen without payload bodies, waiter disconnect with queryable operationId, late result persistence, socket/query identity, terminal conflict, legacy fallback, current ownership and initiating-user/client isolation, revoked-during-wait delivery, offline/restarted/no-result query, and bounded queries.
- [ ] Implement metadata-only repository migration and indexed retention, access policy, and operation service. Transactions end before network I/O.
- [ ] Negotiate using v1 hello/server.notice/agent.recovery. Dispatch operation.call only once on negotiated peers; legacy peers receive unchanged tool.call. Validate active socket before updating metadata.
- [ ] Register the read-only MCP query tool and put stable operationId in ambiguity/timeout error details. Preserve successful tool response shapes and distinguish nested tool isError from transport success.
- [ ] Add request-correlated metadata logs and close-code diagnostics without raw reason/payload secrets.
- [ ] Run Server tests/typecheck and relevant MCP/e2e tests; resolve failures introduced by the additional control tool/schema migration.

## Task 4: Upstream isolation, end-to-end acceptance and handoff

**Files:** new `packages/tool-contracts/`; move generated catalog/schema helpers from adapter with compatibility re-exports; package manifests/lock workspace; generator output path; Server catalog import, Dockerfile; upstream guard script/tests and CI wiring; recovery e2e tests; authoritative `docs/agent.md`, `docs/protocol.md`, `docs/architecture.md`, `docs/security.md` as needed.

**Interfaces:** pure tool-contracts exports DESKTOP_COMMANDER_TOOL_MANIFEST, addDeviceIdToToolSchema and associated types, without runtime executor dependencies. Adapter public exports remain source-compatible. Upstream guard accepts a repository root and an optional installed-package path so it can verify real artifacts in source and packaged smoke jobs.

- [ ] Write failing executable guard tests for changed upstream pin, patches/replacement sources, deep implementation imports, modified installed upstream files, and original package success.
- [ ] Extract the pure catalog package without changing the original generated catalog content or desktop-commander-client.ts. Ensure Server dependency/install closure no longer needs the runtime adapter, update lockfile with pinned pnpm, and keep upstream external in Agent build.
- [ ] Add real websocket recovery e2e with a controlled local executor effect, all four peer capability combinations, and a real original-Desktop-Commander stdio acceptance scenario in isolated temporary files.
- [ ] Run repository test:run, typecheck, relevant e2e, governance/diff/privacy checks and original/package integrity checks; run Windows validation in the isolated user-device worktree with no replacement of its connected Agent.
- [ ] Review the whole branch, resolve material findings, preserve the branch on the user's device, and report exact passing/failed/not-run gates. Keep deployment and publishing separate.

## Execution notes

The user approved the design constraints and asked to continue. Use the existing authorization to implement and verify without extra stage-confirmation prompts. Task 1 is the shared contract gate. Tasks 2 and 3 have disjoint source ownership and may proceed concurrently after that contract is fixed, as required by the active parallel-delegation policy; stage/commit integration is serialized. Task 4 owns package/Docker/CI changes to avoid concurrent edits.
