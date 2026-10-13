# V1 Relay, Agent & Desktop Commander Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Agent 主动出站连接、自恢复 Relay、设备实时状态、请求投递/去重/不确定执行语义，以及本地 Desktop Commander stdio bridge。

**Architecture:** Server 通过 Fastify WebSocket route 维护每台设备一个活动 relay connection；实时连接状态只在内存中。Agent 使用长期设备 credential 刷新短期 access token，再通过 WSS 连接。Agent 启动并保持一个 Desktop Commander stdio child，使用标准 MCP client 调用其 tools。Relay 只转发结构化工具请求，不实现任何 Desktop Commander 工具逻辑。

**Tech Stack:** Node.js 24、TypeScript、Fastify 5、@fastify/websocket 11、@modelcontextprotocol/client v2、@napi-rs/keyring 2（optional/native credential backend）、Desktop Commander pinned `@wonderwhy-er/desktop-commander@0.2.52`、Vitest 5。

**Spec:** `docs/superpowers/specs/2026-10-01-open-desktop-remote-design.zh-CN.md`

## Global Constraints

- Agent 只建立 outbound WSS；工作电脑无需开放入站端口。
- 只有 `READY` 设备可以接受新工具调用。
- Relay socket 连接与 Desktop Commander executor readiness 必须分离。
- Server 不持久化 live socket、pending request、heartbeat 或 transient readiness。
- Server 不自动重放已下发但结果不确定的工具调用。
- Agent 对已完成 `requestId` 保留有界结果缓存。
- 断线重连不重新配对，也不因网络断开自动重启 Desktop Commander child。
- V1 每个 Agent 管理一个 Desktop Commander stdio process。
- Desktop Commander 执行权限等于 Agent 进程的 OS 用户权限。
- Desktop Commander pinned compatibility target：`0.2.52`；manifest 必须由真实 `tools/list` 校验。
- Tool result 默认最大序列化大小：8 MiB，可由 Server 配置覆盖；超限必须返回结构化错误而不是继续中转完整 payload。

## Review Focus

1. WebSocket 连上但 executor 未初始化成功时设备绝不能显示 READY。Task 2/5 覆盖。
2. 网络在 tool dispatch 后、result 前断开时 Server 必须得到 `EXECUTION_UNKNOWN`，不能 retry。Task 6 覆盖。
3. 同一 `requestId` 再次到达 Agent 时，如果已完成必须返回缓存结果而不是重新执行。Task 6 覆盖。
4. 被 revoke 的设备持有旧 access token 重连时必须被拒绝。Task 2 集成测试覆盖。
5. Desktop Commander child crash 后已有网络连接可以保留，但状态必须离开 READY，恢复后重新 READY。Task 5 覆盖。

---

### Task 1: Agent package and credential storage

**Files:**
- Create: `apps/agent/package.json`
- Create: `apps/agent/tsconfig.json`
- Create: `apps/agent/src/config.ts`
- Create: `apps/agent/src/credentials/credential-store.ts`
- Create: `apps/agent/src/credentials/keyring-store.ts`
- Create: `apps/agent/src/credentials/file-store.ts`
- Create: `apps/agent/src/credentials/credential-store.test.ts`
- Create: `apps/agent/src/index.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: none.
- Produces:
  - `CredentialStore { get(): Promise<DeviceCredential | null>; set(value): Promise<void>; clear(): Promise<void> }`
  - `createCredentialStore(options): CredentialStore`
  - `DeviceCredential = { serverUrl: string; deviceId: string; refreshCredential: string }`.

- [ ] **Step 1: Write failing credential-store tests**

Using a fake native backend, assert native keyring is preferred.

Force native backend failure and assert fallback file store:
- writes JSON under per-user app data directory;
- creates parent directory;
- POSIX mode is 0600;
- never prints credential content;
- `clear()` removes both native/file copies when applicable.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/agent test:run -- credential-store`

Expected: FAIL.

- [ ] **Step 3: Implement credential storage**

Use `@napi-rs/keyring` as optional native backend with service name `open-desktop-remote`. If unavailable, use a per-user file. Windows native backend is expected to be the normal path; document that file fallback is weaker and remains user-profile scoped.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/agent test:run && pnpm --filter @open-desktop-remote/agent typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent pnpm-workspace.yaml
git commit -m "feat(agent): add credential storage foundation"
```

### Task 2: Server relay connection registry and heartbeat

**Files:**
- Create: `apps/server/src/relay/connection-registry.ts`
- Create: `apps/server/src/relay/relay-route.ts`
- Create: `apps/server/src/relay/heartbeat.ts`
- Create: `apps/server/src/relay/relay-route.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `verifyDeviceAccess`, protocol schemas, device state machine.
- Produces:
  - `LiveDeviceConnection = { deviceId: string; state: DeviceState; connectedAt: number; lastHeartbeatAt: number; send(message: RelayMessage): void }`
  - `LiveDeviceStatus = { deviceId: string; state: DeviceState; connectedAt?: number; lastHeartbeatAt?: number }`
  - `ConnectionRegistry.attach(deviceId: string, socket: WebSocket): void`
  - `ConnectionRegistry.detach(deviceId: string, socket: WebSocket): void`
  - `ConnectionRegistry.get(deviceId: string): LiveDeviceConnection | undefined`
  - `ConnectionRegistry.snapshot(): LiveDeviceStatus[]`
  - WSS route `/relay`.

- [ ] **Step 1: Write failing relay auth/state tests**

Assert:
- missing/invalid token closes connection before AUTHENTICATED;
- revoked device is rejected;
- valid device follows CONNECTED then AUTHENTICATED;
- a second connection for same device replaces the old socket deterministically;
- heartbeat expiry removes READY and detaches stale socket;
- valid heartbeat/READY updates durable device `lastSeenAt` metadata without持久化 payload；
- raw relay payload is rejected unless `RelayMessageSchema` accepts it.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- relay-route`

Expected: FAIL.

- [ ] **Step 3: Implement registry and heartbeat**

Heartbeat interval target: 15 seconds. Declare device stale after 45 seconds without valid heartbeat.

Socket attach/detach operations must be identity-aware so an old socket closing cannot detach a newer replacement socket.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/server test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/relay apps/server/src/app.ts
git commit -m "feat(relay): add authenticated device connections"
```

### Task 3: Agent pairing and access-token refresh client

**Files:**
- Create: `apps/agent/src/http/server-client.ts`
- Create: `apps/agent/src/pairing/pair-device.ts`
- Create: `apps/agent/src/auth/device-token.ts`
- Create: `apps/agent/src/pairing/pair-device.test.ts`
- Modify: `apps/agent/src/index.ts`

**Interfaces:**
- Consumes: Plan 2 pairing/refresh HTTP APIs, `CredentialStore`.
- Produces:
  - `PairingUi = { showVerification(input: { verificationUri: string; userCode: string }): void }`
  - `pairDevice(serverUrl: URL, io: PairingUi): Promise<DeviceCredential>`
  - `refreshRelayToken(credential: DeviceCredential): Promise<{ accessToken: string; expiresAt: number; deviceId: string }>`
  - CLI command `agent connect --server <url>`.

- [ ] **Step 1: Write failing client tests**

Mock HTTP and assert:
- first run without credentials starts pairing;
- verification URL + user code are shown;
- polling respects server interval;
- approval stores credential exactly once;
- expired/denied pairing returns actionable error;
- existing valid credential skips pairing;
- revoked refresh credential tells user to pair again rather than looping forever.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/agent test:run -- pair-device`

Expected: FAIL.

- [ ] **Step 3: Implement pairing client and CLI entry**

No browser automation is required; print verification URL and code. Browser auto-open may be added later but is not acceptance-critical.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/agent test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src
git commit -m "feat(agent): add device pairing client"
```

### Task 4: Desktop Commander stdio adapter compatibility spike turned production gate

**Files:**
- Create: `packages/desktop-commander-adapter/package.json`
- Create: `packages/desktop-commander-adapter/tsconfig.json`
- Create: `packages/desktop-commander-adapter/src/desktop-commander-client.ts`
- Create: `packages/desktop-commander-adapter/src/manifest.ts`
- Create: `packages/desktop-commander-adapter/src/manifest.generated.json`
- Create: `packages/desktop-commander-adapter/src/desktop-commander-client.integration.test.ts`
- Create: `packages/desktop-commander-adapter/scripts/generate-manifest.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: `@modelcontextprotocol/client` stdio transport.
- Produces:
  - `DesktopCommanderClient.start(options): Promise<DesktopCommanderClient>`
  - `client.listTools(): Promise<ToolDefinition[]>`
  - `client.callTool(name: string, args: unknown): Promise<CallToolResult>`
  - `client.close(): Promise<void>`
  - generated `DESKTOP_COMMANDER_TOOL_MANIFEST`.

- [ ] **Step 1: Write failing live integration test**

The test launches:
`npx -y @wonderwhy-er/desktop-commander@0.2.52 --no-onboarding`

Assert MCP initialize succeeds, `tools/list` returns a non-empty tool set including representative file/process tools, and a harmless tool such as `get_config` can be invoked.

If official MCP v2 client cannot negotiate stdio with the pinned Desktop Commander version, STOP implementation and revise this adapter boundary rather than adding an undocumented protocol shim.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/desktop-commander-adapter test:integration`

Expected: FAIL because adapter is not implemented.

- [ ] **Step 3: Implement stdio adapter and manifest generator**

Do not use Desktop Commander's official `remote` mode. Spawn the ordinary local stdio MCP server.

Manifest generator writes stable tool name, description, and input JSON schema; generated output is committed.

- [ ] **Step 4: Verify live manifest**

Run:
`pnpm --filter @open-desktop-remote/desktop-commander-adapter generate:manifest && pnpm --filter @open-desktop-remote/desktop-commander-adapter test:integration`

Expected: PASS and working tree remains clean after regenerating the manifest.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-commander-adapter pnpm-workspace.yaml
git commit -m "feat(adapter): bridge desktop commander over stdio"
```

### Task 5: Agent executor lifecycle and readiness

**Files:**
- Create: `apps/agent/src/executor/executor-manager.ts`
- Create: `apps/agent/src/executor/executor-manager.test.ts`
- Create: `apps/agent/src/relay/relay-client.ts`
- Create: `apps/agent/src/relay/relay-client.test.ts`
- Modify: `apps/agent/src/index.ts`

**Interfaces:**
- Consumes: DesktopCommanderClient, protocol messages, device credential/token client.
- Produces:
  - `ExecutorManager.start(): Promise<void>`
  - `ExecutorManager.state(): DeviceState`
  - `ExecutorManager.callTool(name,args): Promise<CallToolResult>`
  - `RelayClient.run(signal: AbortSignal): Promise<void>`.

- [ ] **Step 1: Write failing lifecycle tests**

With fake DesktopCommanderClient:
- relay connect alone never emits READY;
- successful executor initialize emits EXECUTOR_STARTING then READY;
- executor crash moves state to EXECUTOR_FAILED;
- bounded restart backoff can restore READY;
- network reconnect does not call executor.close/restart;
- protocol incompatibility emits INCOMPATIBLE and stops normal reconnect loop.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/agent test:run -- executor-manager`

Expected: FAIL.

- [ ] **Step 3: Implement lifecycle**

Agent sends `agent.hello` first, negotiates protocol, starts/validates executor, then sends `agent.ready`.

Reconnect uses exponential backoff with jitter, reset after a stable connection.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/agent test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/executor apps/agent/src/relay apps/agent/src/index.ts
git commit -m "feat(agent): manage executor readiness and reconnect"
```

### Task 6: Tool dispatch, deduplication, cancellation and ambiguous delivery

**Files:**
- Create: `apps/agent/src/requests/request-cache.ts`
- Create: `apps/agent/src/requests/tool-dispatcher.ts`
- Create: `apps/agent/src/requests/tool-dispatcher.test.ts`
- Create: `apps/server/src/relay/request-broker.ts`
- Create: `apps/server/src/relay/request-broker.test.ts`
- Modify: `apps/agent/src/relay/relay-client.ts`
- Modify: `apps/server/src/relay/relay-route.ts`

**Interfaces:**
- Consumes: live connection registry, DesktopCommanderClient, protocol request/result messages.
- Produces:
  - `RequestBroker.call(deviceId: string, toolName: string, args: unknown, options: { timeoutMs: number }): Promise<ToolResultMessage>`
  - `RequestBroker.cancel(requestId: string): void`
  - `ToolDispatcher.handle(call: ToolCallMessage): Promise<ToolResultMessage | ToolErrorMessage>`
  - bounded completed-request cache keyed by `requestId`.

- [ ] **Step 1: Write failing delivery-semantics tests**

Pin:
- same completed `requestId` twice invokes local tool once and returns cached result twice;
- different request IDs invoke independently;
- socket drop before dispatch returns DEVICE_OFFLINE/NOT_READY, not EXECUTION_UNKNOWN;
- socket drop after dispatch but before result returns `EXECUTION_UNKNOWN`;
- broker never re-sends ambiguous call on reconnect;
- explicit cancellation sends `tool.cancel`;
- timeout returns `REQUEST_TIMEOUT` if request was never ambiguously dispatched;
- late result after timeout is ignored for upstream response but may populate Agent completed cache;
- serialized result larger than configured 8 MiB default is rejected with a stable tool execution/size error and raw body is not logged or persisted.

- [ ] **Step 2: Run test to verify failure**

Run:
`pnpm --filter @open-desktop-remote/agent test:run -- tool-dispatcher && pnpm --filter @open-desktop-remote/server test:run -- request-broker`

Expected: FAIL.

- [ ] **Step 3: Implement broker and dispatcher**

Completed request cache target: max 1000 entries or 15 minutes, whichever evicts first.

Server tracks request phase explicitly: `CREATED | DISPATCHED | COMPLETED | AMBIGUOUS`.

No automatic replay exists anywhere in this path.

- [ ] **Step 4: Run full plan verification**

Run: `pnpm test:run && pnpm typecheck`

Expected: PASS.

Then run live adapter integration separately:
`pnpm --filter @open-desktop-remote/desktop-commander-adapter test:integration`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent apps/server/src/relay
git commit -m "feat(relay): add safe remote tool dispatch"
```

## Plan 3 Exit Criteria

- A real Agent can pair, refresh auth, connect outbound via WSS and become READY only after Desktop Commander is usable.
- Server can route a structured tool call to a fake or real Agent and receive a result.
- Temporary relay loss does not restart Desktop Commander.
- Executor crash is visible separately from transport connectivity.
- Duplicate request IDs do not re-execute completed calls.
- Ambiguous disconnects produce `EXECUTION_UNKNOWN` and are never silently replayed.
