# V1 Foundation & Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 Open Desktop Remote V1 的 TypeScript monorepo 基础、公共协议包、设备状态机和协议兼容性协商，为后续 Auth、Relay、Agent 和 MCP Gateway 提供稳定接口。

**Architecture:** 本计划只创建可独立测试的基础层，不实现真实网络服务。协议数据结构集中在 `packages/protocol`，设备状态与兼容性逻辑集中在 `packages/shared`，所有后续子系统只依赖这些公开接口，不复制协议常量。

**Tech Stack:** Node.js 24、TypeScript、pnpm workspaces、Vitest 5、Zod 4、ESM、tsx。

**Spec:** `docs/superpowers/specs/2026-10-01-open-desktop-remote-design.zh-CN.md`

## Global Constraints

- 运行时目标：Node.js 24 LTS-compatible。
- 语言：TypeScript，ESM。
- 包管理：pnpm workspaces。
- V1 协议版本：`1`。
- 设备标准状态：`OFFLINE -> CONNECTED -> AUTHENTICATED -> EXECUTOR_STARTING -> READY`。
- 额外状态：`REVOKED`、`INCOMPATIBLE`、`EXECUTOR_FAILED`。
- 只有 `READY` 设备可接受新工具调用。
- 协议必须公开、版本化，并允许第三方实现兼容 Agent。
- Server、Agent、Protocol 版本彼此独立。
- V1 License：Apache-2.0。
- 不实现任何 Desktop Commander 文件/终端业务逻辑。

## Review Focus

1. 收到未知协议消息类型时必须安全拒绝，不能抛出未处理异常。Task 2 增加 malformed/unknown message 测试。
2. Agent 支持范围与 Server 要求范围没有交集时必须返回 `PROTOCOL_INCOMPATIBLE`。Task 4 覆盖。
3. 设备从 `REVOKED` 不允许重新进入在线状态。Task 3 覆盖非法状态迁移。
4. 重复 `requestId` 不能被 schema 当作格式错误；去重语义留给 Relay 层。Task 2 明确只做结构校验。
5. 所有公共错误码必须稳定且可序列化，不能让客户端解析 message 文本。Task 2 覆盖错误 envelope。

---

### Task 1: Monorepo foundation

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/protocol/src/smoke.test.ts`
- Test: `packages/shared/src/smoke.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: workspace packages `@open-desktop-remote/protocol` and `@open-desktop-remote/shared`; root scripts `typecheck`, `test`, `test:run`.

- [ ] **Step 1: Write failing workspace smoke tests**

Create tests that import each package entry point and assert an exported sentinel value exists.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm install && pnpm test:run`

Expected: FAIL because package entry points/sentinels are not implemented yet.

- [ ] **Step 3: Implement the minimal workspace**

Use private workspace package names:
- `@open-desktop-remote/protocol`
- `@open-desktop-remote/shared`

Root package must set `"packageManager": "pnpm@10"`, `"type": "module"`, and `"engines": {"node": ">=24"}`.

TypeScript strict mode must be enabled. Package outputs target `dist/`.

- [ ] **Step 4: Run verification**

Run: `pnpm test:run && pnpm typecheck`

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts .gitignore LICENSE packages
git commit -m "chore: scaffold v1 monorepo"
```

### Task 2: Relay protocol schemas and stable errors

**Files:**
- Create: `packages/protocol/src/version.ts`
- Create: `packages/protocol/src/errors.ts`
- Create: `packages/protocol/src/messages.ts`
- Create: `packages/protocol/src/messages.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: Zod 4.
- Produces:
  - `PROTOCOL_VERSION = 1`
  - `RelayMessageSchema`
  - `parseRelayMessage(input: unknown): RelayMessage`
  - `ProtocolErrorCode`
  - `ProtocolErrorEnvelope`
  - discriminated message types for `agent.hello`, `agent.ready`, `agent.executor_status`, `heartbeat`, `tool.call`, `tool.result`, `tool.error`, `tool.cancel`, `server.notice`.

- [ ] **Step 1: Write failing schema tests**

Tests must assert:
- valid `agent.hello` parses;
- valid `tool.call` preserves `requestId`, `deviceId`, `toolName`, `arguments`;
- unknown `type` is rejected;
- missing `protocolVersion` is rejected;
- malformed UUID-like request identifiers are rejected if the schema requires UUID;
- two separate valid messages may reuse the same `requestId` at schema level;
- error envelopes serialize stable codes.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/protocol test:run`

Expected: FAIL because schemas do not exist.

- [ ] **Step 3: Implement protocol message types**

Use a discriminated union on `type`. All messages contain `protocolVersion: 1`.

Request-bearing messages use:
```ts
type RequestId = string;
type DeviceId = string;
```

Do not put retry/deduplication behavior in this package.

Stable error codes must include:
`DEVICE_NOT_FOUND`, `DEVICE_OFFLINE`, `DEVICE_NOT_READY`, `DEVICE_REVOKED`, `PROTOCOL_INCOMPATIBLE`, `EXECUTOR_FAILED`, `REQUEST_TIMEOUT`, `REQUEST_CANCELLED`, `EXECUTION_UNKNOWN`, `TOOL_NOT_SUPPORTED`, `TOOL_EXECUTION_ERROR`.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/protocol test:run && pnpm --filter @open-desktop-remote/protocol typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): define relay message schemas"
```

### Task 3: Device state machine

**Files:**
- Create: `packages/shared/src/device-state.ts`
- Create: `packages/shared/src/device-state.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: none.
- Produces:
  - `DeviceState`
  - `canAcceptToolCalls(state: DeviceState): boolean`
  - `transitionDeviceState(current: DeviceState, next: DeviceState): DeviceState`
  - `InvalidDeviceStateTransitionError`.

- [ ] **Step 1: Write failing transition tests**

Tests must pin:
- `OFFLINE -> CONNECTED -> AUTHENTICATED -> EXECUTOR_STARTING -> READY` is valid;
- `READY -> OFFLINE` is valid on disconnect;
- `READY -> EXECUTOR_FAILED -> EXECUTOR_STARTING -> READY` is valid;
- `REVOKED -> CONNECTED` throws;
- `INCOMPATIBLE -> READY` throws;
- only `READY` returns true from `canAcceptToolCalls`.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/shared test:run`

Expected: FAIL because state machine is missing.

- [ ] **Step 3: Implement the explicit transition table**

Use an immutable transition map rather than ordinal comparisons so terminal/error states cannot accidentally become valid after future enum additions.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/shared test:run && pnpm --filter @open-desktop-remote/shared typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add device readiness state machine"
```

### Task 4: Protocol compatibility negotiation

**Files:**
- Create: `packages/protocol/src/compatibility.ts`
- Create: `packages/protocol/src/compatibility.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: `PROTOCOL_VERSION`, `ProtocolErrorCode`.
- Produces:
  - `ProtocolRange = { min: number; max: number }`
  - `negotiateProtocol(agent: ProtocolRange, server: ProtocolRange): { version: number } | { error: "PROTOCOL_INCOMPATIBLE" }`.

- [ ] **Step 1: Write failing compatibility tests**

Assertions:
- `{min:1,max:1}` with `{min:1,max:1}` negotiates version 1;
- overlapping ranges choose the highest common version;
- non-overlapping ranges return `PROTOCOL_INCOMPATIBLE`;
- reversed/invalid ranges are rejected before negotiation.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/protocol test:run`

Expected: FAIL.

- [ ] **Step 3: Implement negotiation**

No network or logging behavior belongs here.

- [ ] **Step 4: Run full plan verification**

Run: `pnpm test:run && pnpm typecheck`

Expected: PASS across the entire workspace.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add version negotiation"
```

## Plan 1 Exit Criteria

- Fresh `pnpm install` works on Node 24.
- All protocol and state-machine tests pass.
- No server, agent, auth, WebSocket, SQLite, or Desktop Commander process is implemented yet.
- Later plans can import all protocol constants/types without redefining them.
