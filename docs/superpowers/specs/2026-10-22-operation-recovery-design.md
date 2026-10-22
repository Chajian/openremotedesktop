# Issue 5: recover operations without changing Desktop Commander

## Goal and authority

Implement the agreed Issue #5 recovery path inside OpenRemoteDesktop. The user requires extensibility, maintainable boundaries, and zero modifications to either upstream Desktop Commander project or its installed implementation. The existing isolated reproduction showed a completed local effect whose response was lost after relay disconnection.

## Scope

- Keep one Server, existing SQLite, outbound-only Agent, and the existing local MCP stdio executor interface.
- Separate an operation record from a temporary MCP waiter and a relay socket.
- Recover an existing operation by a read-only query; never replay execution to recover a result.
- Retain Server metadata across Server restart. Retain Agent outcomes in bounded memory, with explicit availability and process-epoch semantics.
- Preserve legacy v1 peers. New recovery messages require bilateral capability negotiation on each connection.
- Keep original upstream packages and executable files unchanged. Extract the Server's pure tool catalog from the runtime adapter and enforce the upstream boundary in checks.

Not included: durable result bodies, Agent-restart result recovery, a job/workflow engine, device-sharing implementation, automatic re-execution, deployment, publishing, or changing the upstream version.

## Identities and failure semantics

The existing relay requestId becomes the stable operationId; a query has a separate queryId. Each Agent process has a random bootId that survives relay reconnection but changes on restart. An operation targets that bootId. Executor replacement invalidates observations of running operations; completed cached outcomes remain readable.

New submissions bind requestId, deviceId, bootId, toolName, arguments and expiresAt. The Agent computes a canonical intent fingerprint in memory; no argument fingerprints or bodies are logged or persisted on Server. Same ID with a different intent is a conflict. The Server never resends operation.call. User submission retries create new operations unless a future explicit idempotency contract is added.

Submit expiry is an admission deadline, not a tool execution timeout. Server uses now + 60 seconds. Agent rejects expired submissions and deadlines more than five minutes ahead of its clock before invoking the executor. Its expiry clock is clamped against backwards movement within this process. Completed metadata is kept until both the submit deadline and outcome retention period have ended. Thus expired metadata cannot make an old submission executable again. Clock skew can conservatively reject a submission; it never authorizes a replay.

Timeout or disconnect ends the waiter with operationId and recovery information. It does not erase metadata or cancel the local effect. A subsequent terminal response can update the operation. Cancellation is recorded independently; a cancellation request cannot overwrite an actual completion outcome or promise rollback.

## Wire contract

Keep protocolVersion 1 and every existing v1 message shape unchanged. Constants:

- OPERATION_RECOVERY_CAPABILITY = `operation-recovery-v1`.
- OPERATION_RECOVERY_NOTICE = `OPERATION_RECOVERY_ENABLED`.
- New Agent includes the capability in its existing agent.hello capabilities array.
- New Server sends the existing server.notice shape with the notice code only to an Agent advertising the capability.
- Agent responds with agent.recovery carrying deviceId and bootId; Server enables recovery only after this response. Before completion, dispatch uses legacy tool.call.

New messages, each with protocolVersion 1 and deviceId:

- agent.recovery: bootId.
- operation.call: requestId, bootId, toolName, arguments, expiresAt.
- operation.query: queryId, requestId, bootId, includeResult (boolean).
- operation.status: queryId, requestId, bootId (responding process), snapshot.

OperationSnapshot is a discriminated union:

- running: startedAt, cancelRequested.
- completed: completedAt, cancelRequested, outcome (`success`, `error`, or `unknown`), payload.
- not_found: no additional fields.
- restarted: no additional fields.

Completed payload is `{ status: 'available', response?: ToolResultMessage | ToolErrorMessage }` or `{ status: 'expired' | 'evicted' | 'unavailable' }`. includeResult=false may omit an otherwise available body. A result inside a status must match the surrounding operation/device IDs. A restarted response never implies that the old operation did not execute.

Normal completion still uses existing tool.result/tool.error frames; the Server authenticates the current socket and its negotiated bootId against the stored operation before applying them. Query responses are correlated by queryId, requestId, deviceId and the exact current connection; late/foreign replies cannot resolve a different query. Unknown message directions and unnegotiated recovery frames are rejected.

## Agent boundaries and limits

Reuse ExecutorClient/ExecutorManager. The operation coordinator owns admission, fingerprint checking, execution evidence and bounded memory; it does not import ws or upstream implementation. The query handler receives only a read-store interface, never an executor or submit function.

Defaults: 32 in-flight operations, 10,000 metadata entries, 64 MiB cached result bodies, 8 MiB per result, and 15 minutes result retention from completion. Reject new work before execution when in-flight or metadata capacity is full. Result-body pressure may evict completed bodies but leaves metadata and explicit evicted availability. A TTL is an upper bound, not a promise against documented capacity eviction. Metadata cleanup never removes running operations. Queries neither delete results nor extend retention.

Store the response before trying to send it. Send through the current authenticated session, not a captured old socket. A failed send leaves the outcome queryable. No result ACK or payload persistence is introduced. Scope the guarantee to a surviving Agent and an available cached result. Preserve genuine tool isError outcomes; output serialization/size failures are not proof that an effect did not occur.

## Server boundaries

Add an OperationRepository using the existing SQLite migration system and an OperationService that owns creation, terminal evidence, authorization and query coordination. RequestBroker manages bounded waiters and wire transport only; its current legacy API can remain for existing tests/adapters.

Metadata contains operationId, requestedByUserId, originatingClientId, deviceId, deviceOwnerIdAtCreation, toolName, bootId or null, phase/terminal classification, timestamps, expiry, and a terminal response digest for conflict detection. It contains no tool arguments, result body, stderr/stdout or error-message body. Default metadata retention is 24 hours; cleanup is indexed and never causes execution. Do not hold a database transaction across network I/O.

AccessPolicy initially implements owned-only access. Invocation, query, and delivery require the current device owner/authorization, and query additionally requires the original requesting user and client. Retain separate actor and device-owner fields for future sharing. Revalidate authorization after waiting before delivering results. An inaccessible operation is indistinguishable from a missing one.

Expose `odr_get_operation` on our MCP Server with operationId (UUID) and optional includeResult (default true). It reads metadata and, where available, asks the negotiated Agent for the existing operation. Query timeout is 5 seconds and at most 64 simultaneous queries per Server. Offline, old-peer, restarted, expired, and missing-cache cases return the known evidence and explicit result availability. They never create or dispatch a tool operation. Successful original tool bodies preserve their existing MCP shape. Unknown/timeout errors carry operationId in structured error details.

## Upstream boundary

Both upstream projects and @wonderwhy-er/desktop-commander@0.2.52 remain unchanged. Keep packages/desktop-commander-adapter/src/desktop-commander-client.ts byte-identical in this change. No forks, patch-package, patchedDependencies, implementation deep imports or scripts rewriting upstream files. The original manifest remains a generated public-tool-contract snapshot; OpenRemote control tools are registered separately.

Create a pure workspace tool-contracts package for the generated catalog and remote schema wrapper. Server depends on it, Agent's runtime adapter depends on it and re-exports public catalog helpers for compatibility. Packaging leaves the upstream external. The Server image installs only Server production dependency closure. An upstream guard validates source/dependency identity and actual package integrity; compatibility tests use the original package.

## Verification

Required behavior: effect then disconnect then reconnect then query returns original result with one execution; query of every missing/expired/restarted state never executes; same ID/different intent rejects; result arriving after waiter completion is retained; terminal evidence does not regress; old sockets cannot modify a newer session; cancellation does not erase real completion; metadata survives Server restart without payload persistence; cross-user/client and revoked access cannot read results; all four old/new peer combinations behave safely; limits and expiry are deterministic.

Run focused red/green tests, repository test:run/typecheck/relevant e2e, governance and diff/privacy checks, then original-package stdio and packaged Agent checks where the environment supports them. Record real-device and platform validation separately. No production deployment follows from passing tests.
