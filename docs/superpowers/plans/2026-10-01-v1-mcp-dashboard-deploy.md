# V1 MCP Gateway, Dashboard & Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已经完成的 Auth、Relay、Agent 和 Desktop Commander Adapter 组合成可被 ChatGPT 使用的标准远程 MCP 服务，并补齐 Dashboard、隐私日志、Docker/Caddy 部署、README 与完整端到端验收。

**Architecture:** MCP Gateway 使用官方 MCP TypeScript SDK v2 的 Streamable HTTP/Fastify adapter。Desktop Commander 的 generated JSON Schema 通过 `fromJsonSchema()` 注册成一等 MCP tools，并增加可选 `deviceId` 参数；handler 调用 Relay RequestBroker。Dashboard 使用服务端渲染的最小 HTML，不引入 SPA 框架。生产参考部署为单 Server container + SQLite volume + Caddy。

**Tech Stack:** Node.js 24、TypeScript、Fastify 5、MCP TypeScript SDK v2（`@modelcontextprotocol/server` + `@modelcontextprotocol/fastify` + E2E 用 `@modelcontextprotocol/client`）、Zod 4、Vitest 5、Docker Compose、Caddy。

**Spec:** `docs/superpowers/specs/2026-10-01-open-desktop-remote-design.zh-CN.md`

## Global Constraints

- MCP transport：Streamable HTTP。
- MCP Server 必须符合当前 OAuth Protected Resource Metadata 发现流程。
- AI 客户端只看到标准 MCP tools；不暴露通用 `call_tool(name,args)`。
- 每个 Desktop Commander tool 增加可选 `deviceId`。
- 唯一 READY 设备时自动选择；多 READY 且未给 `deviceId` 时返回明确选择错误。
- 默认日志不得记录工具参数、文件正文、截图、shell stdout/stderr、token、credential 或 authorization code。
- 生产公网只需 HTTPS/443。
- Docker/Linux 是正式 Server 部署目标。
- fresh clone + README 必须足够另一位技术用户完整部署。
- 不添加自定义聊天 UI、手机 App、离线队列、云文件缓存或多租户。

## Review Focus

1. MCP OAuth token 的 `resource`/scope 不匹配必须返回标准 401/403，而不是让请求进入 tool handler。Task 1 覆盖。
2. 多台 READY 设备且没有 `deviceId` 时绝不能随机选择。Task 2 覆盖。
3. tool input 原 schema 已有 `deviceId` 字段时 adapter 必须检测冲突而不是覆盖。Task 2 覆盖。
4. 日志错误对象中嵌套 token/arguments 也必须脱敏。Task 4 覆盖递归 redaction。
5. Docker 容器重启后 SQLite Owner/设备注册仍存在，但 live devices 必须显示 OFFLINE 直到 Agent 重连。Task 5/6 E2E 覆盖。

---

### Task 1: Standard MCP Streamable HTTP endpoint and OAuth resource protection

**Files:**
- Create: `apps/server/src/mcp/mcp-handler.ts`
- Create: `apps/server/src/mcp/resource-metadata.ts`
- Create: `apps/server/src/mcp/auth-verifier.ts`
- Create: `apps/server/src/mcp/mcp-auth.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/package.json`

**Interfaces:**
- Consumes: Plan 2 `verifyAccessToken`, Server public base URL.
- Produces:
  - `GET/POST /mcp`
  - `/.well-known/oauth-protected-resource/mcp`
  - bearer challenge with resource metadata URL
  - `buildMcpServer(deps): McpServer`.

- [ ] **Step 1: Write failing MCP auth tests**

Assert:
- unauthenticated `/mcp` returns 401 and `WWW-Authenticate` with resource metadata;
- resource metadata points to this Server's authorization server;
- valid access token with wrong resource is rejected;
- missing `mcp` scope is rejected;
- valid token reaches MCP initialize;
- OAuth metadata advertises PKCE S256 and the DCR endpoint built in Plan 2.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- mcp-auth`

Expected: FAIL.

- [ ] **Step 3: Implement MCP v2 HTTP integration**

Use `@modelcontextprotocol/server` v2 and `@modelcontextprotocol/fastify`. Keep MCP request handling stateless; do not bind device identity or process sessions to an MCP HTTP session.

Use the official bearer-auth/resource metadata helpers where they fit, backed by the project's opaque token verifier.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/server test:run && pnpm --filter @open-desktop-remote/server typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp apps/server/src/app.ts apps/server/package.json
git commit -m "feat(mcp): expose oauth-protected streamable http"
```

### Task 2: Dynamic first-class Desktop Commander tool registration and device routing

**Files:**
- Create: `packages/desktop-commander-adapter/src/remote-tool-schema.ts`
- Create: `packages/desktop-commander-adapter/src/remote-tool-schema.test.ts`
- Create: `apps/server/src/mcp/register-desktop-tools.ts`
- Create: `apps/server/src/mcp/device-router.ts`
- Create: `apps/server/src/mcp/device-router.test.ts`
- Modify: `apps/server/src/mcp/mcp-handler.ts`

**Interfaces:**
- Consumes: generated Desktop Commander manifest, `fromJsonSchema`, ConnectionRegistry, RequestBroker.
- Produces:
  - `addDeviceIdToToolSchema(tool): RemoteToolDefinition`
  - `selectTargetDevice(requestedDeviceId?: string): DeviceId`
  - registration of every manifest tool as a first-class MCP tool.

- [ ] **Step 1: Write failing schema/routing tests**

Schema assertions:
- original tool properties are preserved;
- optional `deviceId: string` is added;
- required fields remain unchanged;
- schema containing an existing `deviceId` fails generation with explicit conflict.

Routing assertions:
- explicit READY `deviceId` is selected;
- explicit offline/not-ready device returns correct stable error;
- exactly one READY device auto-selects;
- multiple READY devices with no ID returns structured selection error listing names/IDs;
- zero READY devices returns `DEVICE_NOT_READY`/offline structured result.

- [ ] **Step 2: Run tests and verify failure**

Run:
`pnpm --filter @open-desktop-remote/desktop-commander-adapter test:run -- remote-tool-schema && pnpm --filter @open-desktop-remote/server test:run -- device-router`

Expected: FAIL.

- [ ] **Step 3: Implement registration**

Use MCP SDK `fromJsonSchema()` to wrap the generated JSON schema. Remove `deviceId` from arguments before forwarding to local Desktop Commander.

Tool results from Desktop Commander are returned without semantic rewriting. Relay/system failures map to MCP tool errors with machine-readable code included in structured content.

Also register control tools:
- `list_devices`
- `get_device_status`.

- [ ] **Step 4: Run verification**

Run: `pnpm test:run && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-commander-adapter apps/server/src/mcp
git commit -m "feat(mcp): route desktop commander tools by device"
```

### Task 3: Minimal Owner Dashboard

**Files:**
- Create: `apps/server/src/dashboard/templates.ts`
- Create: `apps/server/src/dashboard/routes.ts`
- Create: `apps/server/src/dashboard/csrf.ts`
- Create: `apps/server/src/dashboard/dashboard.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: Owner session, DeviceRepository, ConnectionRegistry.
- Produces browser pages/actions for login, pending pairing approval, device list, rename, revoke, revoke-all, MCP setup instructions, health/version.

- [ ] **Step 1: Write failing Dashboard tests**

Assert:
- unauthenticated admin pages redirect to login;
- state-changing POST requires CSRF token;
- device table displays friendly name, device ID short form, OS, durable last-seen, live state, Agent version, Desktop Commander version;
- pending pairing can be approved;
- rename does not change device ID;
- revoke immediately changes management state;
- MCP connection page displays canonical `https://host/mcp` URL and OAuth-enabled instructions;
- Owner can rotate/change the Dashboard password only after confirming the current password; existing Dashboard sessions except the current one are invalidated;
- HTML escapes all user/device-supplied strings.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- dashboard`

Expected: FAIL.

- [ ] **Step 3: Implement server-rendered Dashboard**

No React/Vue/build pipeline. Use small template functions with explicit HTML escaping and POST/Redirect/GET.

Dashboard is administration only; do not add chat, terminal emulator, file browser, or tool invocation UI.

Password rotation reuses the Plan 2 password hasher and updates the single Owner row transactionally; document recovery/reset as a host-side maintenance operation.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/server test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/dashboard apps/server/src/app.ts
git commit -m "feat(dashboard): add minimal device administration"
```

### Task 4: Privacy-safe structured logging

**Files:**
- Create: `packages/shared/src/redaction.ts`
- Create: `packages/shared/src/redaction.test.ts`
- Create: `apps/server/src/logging.ts`
- Create: `apps/agent/src/logging.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/agent/src/index.ts`

**Interfaces:**
- Consumes: request IDs, tool names, device IDs.
- Produces:
  - `redactSensitive(value: unknown): unknown`
  - metadata-only structured tool call log events
  - explicit `DEBUG_PAYLOAD_LOGGING=false` default.

- [ ] **Step 1: Write failing redaction tests**

Recursively verify redaction of keys including:
`authorization`, `accessToken`, `refreshToken`, `refreshCredential`, `deviceCode`, `authorizationCode`, `password`, `arguments`, `stdout`, `stderr`, `content`, `screenshot`.

Verify ordinary metadata such as `requestId`, `deviceId`, `toolName`, `durationMs`, `errorCode` remains.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/shared test:run -- redaction`

Expected: FAIL.

- [ ] **Step 3: Implement logging policy**

Normal logs never serialize raw relay/MCP message objects.

Debug payload logging must require an explicit environment flag and emit a startup warning before any payload can be logged.

No telemetry endpoint/package is added.

- [ ] **Step 4: Run verification**

Run: `pnpm test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/server/src/logging.ts apps/agent/src/logging.ts apps/server/src/app.ts apps/agent/src/index.ts
git commit -m "feat(logging): add privacy-safe structured logs"
```

### Task 5: Docker, Caddy and production configuration

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `docker/Caddyfile`
- Create: `.env.example`
- Create: `apps/server/src/health/routes.ts`
- Create: `apps/server/src/health/routes.test.ts`
- Modify: `apps/server/src/config.ts`

**Interfaces:**
- Consumes: built Server app.
- Produces:
  - Server container listening internally on one HTTP port;
  - SQLite persisted under `/data`;
  - `/healthz` liveness and `/readyz` readiness;
  - Caddy public HTTPS reverse proxy.

- [ ] **Step 1: Write failing config/health tests**

Assert production refuses:
- missing public base URL;
- non-HTTPS public base URL;
- known/default bootstrap/session secrets if any secret is configured externally.

Assert health endpoints do not leak device/tool payloads.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- health`

Expected: FAIL.

- [ ] **Step 3: Implement deployment files**

Compose services:
- `server`
- `caddy`.

Expose only Caddy 80/443 externally (80 solely for ACME redirect/challenge); do not expose SQLite or internal Server port publicly.

Persist `/data` volume.

- [ ] **Step 4: Build and verify**

Run:
`docker compose config && docker build -t open-desktop-remote:test .`

Expected: both exit 0.

Then run container locally with an HTTP dev override and verify `/healthz`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml docker .env.example apps/server/src/health apps/server/src/config.ts
git commit -m "feat(deploy): add self-hosted docker stack"
```

### Task 6: End-to-end tests for MCP -> Relay -> Agent -> Desktop Commander

**Files:**
- Create: `tests/e2e/helpers/test-server.ts`
- Create: `tests/e2e/helpers/test-agent.ts`
- Create: `tests/e2e/mcp-remote.test.ts`
- Create: `tests/e2e/reconnect.test.ts`
- Create: `tests/e2e/multi-device.test.ts`
- Create: `tests/e2e/privacy.test.ts`
- Modify: root `package.json`
- Modify: `vitest.workspace.ts`

**Interfaces:**
- Consumes: all V1 subsystems.
- Produces: repeatable local E2E suite using official MCP client v2 plus a real Agent/real Desktop Commander for selected tests.

- [ ] **Step 1: Write E2E acceptance tests**

At minimum prove:
- OAuth-protected MCP initialize;
- `list_devices`;
- one READY device auto-routing;
- read a temporary file;
- modify a temporary file;
- start a harmless long-running process/session and continue interacting;
- server-relay disconnect/reconnect without re-pair;
- ambiguous dispatch is not replayed;
- pair a second fake/real device and explicit `deviceId` routing works;
- revoke one device while another remains usable;
- two MCP clients can issue independent concurrent requests to the same READY device with distinct request IDs;
- server restart preserves durable registration but starts live status OFFLINE;
- normal logs and SQLite contain no known test payload marker/token.

- [ ] **Step 2: Run suite and observe failures**

Run: `pnpm test:e2e`

Expected: failures identify any remaining integration gaps.

- [ ] **Step 3: Fix only integration defects required by the acceptance tests**

Do not expand product scope while fixing E2E. Any newly discovered architectural requirement stops implementation and updates the spec/plan first.

- [ ] **Step 4: Run full quality gate**

Run:
```bash
pnpm test:run
pnpm typecheck
pnpm test:e2e
docker compose config
docker build -t open-desktop-remote:test .
```

Expected: all PASS/exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests package.json vitest.workspace.ts
git commit -m "test: cover remote desktop end to end"
```

### Task 7: Self-hosting, security and protocol documentation

**Files:**
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/protocol.md`
- Create: `docs/self-hosting.md`
- Create: `docs/security.md`
- Create: `docs/agent.md`
- Modify: `package.json` as needed for CLI examples.

**Interfaces:**
- Consumes: actual implemented commands/configuration.
- Produces: complete operator documentation for fresh-clone reproduction.

- [ ] **Step 1: Write documentation acceptance checklist before prose**

Checklist must contain exact steps for:
clone -> configure domain -> compose up -> bootstrap Owner -> start Agent -> pair -> connect ChatGPT -> run file test -> add second device -> revoke device -> upgrade/backup.

- [ ] **Step 2: Draft docs from the actual implementation**

`docs/protocol.md` documents every Relay message, protocol version negotiation, request delivery semantics, and error codes.

`docs/security.md` states clearly:
- self-hosted Server is trusted;
- payloads may be visible in Server memory;
- default logs exclude payload bodies;
- Agent runs with current OS user authority;
- Desktop Commander directory controls are not presented as a complete sandbox;
- VM/container/low-privilege account is recommended for stronger isolation.

- [ ] **Step 3: Reproduce README from a clean checkout**

Use a new temporary clone or git worktree and follow the README literally. Do not rely on globally linked workspace packages or unpublished local state.

Expected: Server starts and the documented local acceptance flow reaches a READY Agent.

- [ ] **Step 4: Run final repository checks**

Run:
`git diff --check && pnpm test:run && pnpm typecheck && pnpm test:e2e`

Expected: PASS and clean diff formatting.

- [ ] **Step 5: Commit**

```bash
git add README.md docs package.json
git commit -m "docs: add self-hosting and protocol guide"
```

### Task 8: Cross-platform CI and release smoke gates

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/agent-smoke.yml`
- Create: `scripts/smoke-agent.mjs`

**Interfaces:**
- Consumes: built Server/Agent/adapter packages and test scripts.
- Produces: repeatable Linux server CI plus Windows/macOS/Linux Agent smoke matrix.

- [ ] **Step 1: Add a failing smoke script contract**

`scripts/smoke-agent.mjs` must exit non-zero unless it can start the Agent package in a test mode, load protocol/credential-store/executor modules, and confirm the local runtime is supported without contacting a maintainer-owned service.

- [ ] **Step 2: Add CI workflows**

`ci.yml` on Linux runs install, typecheck, unit/integration tests, and Docker build.

`agent-smoke.yml` uses a matrix of `windows-latest`, `macos-latest`, and `ubuntu-latest`; it installs Node 24 + pnpm, builds the workspace, runs Agent unit tests and `node scripts/smoke-agent.mjs`.

Do not require production secrets or a real public domain in pull-request CI.

- [ ] **Step 3: Validate workflow syntax locally where possible**

Run: `pnpm test:run && pnpm typecheck && node scripts/smoke-agent.mjs`

Expected: PASS on the current development platform.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows scripts/smoke-agent.mjs
git commit -m "ci: add cross-platform agent smoke gates"
```

## Plan 4 Exit Criteria

- ChatGPT-compatible remote MCP endpoint exists at a stable HTTPS URL.
- Standard OAuth discovery + Authorization Code/PKCE works without mandatory external IdP.
- Desktop Commander tools appear as first-class tools with optional `deviceId`.
- Multi-device routing behavior matches the approved spec.
- Dashboard supports required single-owner administration only.
- Default logging/persistence excludes work payload bodies.
- Docker Compose + Caddy reference deployment works.
- Fresh README reproduction and end-to-end V1 acceptance suite pass.
- CI runs Linux Server checks and Windows/macOS/Linux Agent smoke gates.
