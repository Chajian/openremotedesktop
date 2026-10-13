# V1 Auth & Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现单 Owner 自托管 Server 的持久化、首次初始化、Owner 登录、OAuth Authorization Code + PKCE、动态客户端注册、设备配对、设备注册表和撤销能力。

**Architecture:** `apps/server` 使用 Fastify 5；SQLite 由 `better-sqlite3` 访问。OAuth Authorization Server 使用 `@jmondi/oauth2-server@5` 作为协议引擎，项目自己实现 SQLite-backed repository/model 与 MCP 所需 metadata/DCR 边界。Owner Dashboard 登录使用独立 server-side session cookie，不把 Dashboard session 当成 MCP access token。

**Tech Stack:** Node.js 24、TypeScript、Fastify 5、better-sqlite3 13、@jmondi/oauth2-server 5、Zod 4、Vitest 5、Node `crypto.scrypt`。

**Spec:** `docs/superpowers/specs/2026-10-01-open-desktop-remote-design.zh-CN.md`

## Global Constraints

- 只有一个 Owner；没有公开注册接口。
- bootstrap 成功后必须自动禁用，除非从 Server 主机侧显式 reset。
- OAuth 面向 AI 客户端采用 Authorization Code + PKCE S256。
- 服务端不依赖 Google/GitHub/Auth0/Supabase/Firebase 等 SaaS。
- 支持 ChatGPT 所需的 OAuth metadata 与 DCR 路径。
- 长期 device credential 服务端只保存不可逆 verifier。
- 撤销设备后新的 relay 认证必须立即失败。
- SQLite 是 V1 唯一必需数据库。
- token、authorization code、device secret、密码不得出现在日志。

## Review Focus

1. bootstrap race：两个并发首次初始化只能有一个成功。Task 2 用事务测试。
2. OAuth redirect URI 必须精确匹配已注册值，不能做前缀匹配。Task 4 覆盖。
3. PKCE 只接受 S256，拒绝 missing/plain。Task 4 覆盖。
4. DCR 传入无效/非 HTTPS redirect URI 时必须拒绝；localhost 开发回调例外。Task 3 覆盖。
5. 已撤销设备即使拿着未过期旧 access token，也不能建立新的 relay 会话。Task 6 的 credential verification 测试覆盖 revocation check。

---

### Task 1: Server package and SQLite migration layer

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/db/database.ts`
- Create: `apps/server/src/db/migrations.ts`
- Create: `apps/server/src/db/schema.sql`
- Create: `apps/server/src/db/database.test.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: `@open-desktop-remote/shared`.
- Produces:
  - `createDatabase(path: string): betterSqlite3.Database`
  - `runMigrations(db: betterSqlite3.Database): void`
  - `AppDependencies = { db: betterSqlite3.Database; config: ServerConfig }`
  - `buildApp(deps: AppDependencies): FastifyInstance`.

- [ ] **Step 1: Write failing database tests**

Use a temporary SQLite file. Assert migrations create:
`owner`, `owner_sessions`, `oauth_clients`, `oauth_codes`, `oauth_tokens`, `devices`, `device_pairings`, `device_credentials`, `settings`.

Assert migrations are idempotent.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run`

Expected: FAIL because server/database modules do not exist.

- [ ] **Step 3: Implement database bootstrap**

Enable WAL and foreign keys. Migration execution must be transactional.

Store timestamps as integer Unix milliseconds. Never store raw owner password or raw long-lived device credential.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/server test:run && pnpm --filter @open-desktop-remote/server typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server pnpm-workspace.yaml
git commit -m "feat(server): add sqlite persistence foundation"
```

### Task 2: Single-owner bootstrap and dashboard session auth

**Files:**
- Create: `apps/server/src/auth/password.ts`
- Create: `apps/server/src/auth/owner-repository.ts`
- Create: `apps/server/src/auth/session-repository.ts`
- Create: `apps/server/src/routes/bootstrap.ts`
- Create: `apps/server/src/routes/login.ts`
- Create: `apps/server/src/auth/owner-auth.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: SQLite database.
- Produces:
  - `hashPassword(password: string): Promise<string>`
  - `verifyPassword(password: string, encoded: string): Promise<boolean>`
  - `Owner = { id: string; createdAt: number }`
  - `OwnerPrincipal = { ownerId: string }`
  - `SessionToken = string`
  - `bootstrapOwner(input: { password: string }): Promise<Owner>`
  - `createOwnerSession(ownerId: string): SessionToken`
  - `requireOwnerSession(request): OwnerPrincipal`.

- [ ] **Step 1: Write failing auth tests**

Pin:
- first bootstrap succeeds;
- second bootstrap returns conflict;
- concurrent bootstrap attempts result in exactly one owner row;
- wrong password cannot create a session;
- correct password yields an HttpOnly, Secure-in-production, SameSite=Lax cookie;
- stored session value is verifier/hash material, not raw cookie token;
- session expiry is enforced.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- owner-auth`

Expected: FAIL.

- [ ] **Step 3: Implement owner auth**

Use Node `crypto.scrypt` with random per-password salt and constant-time comparison.

Bootstrap endpoint is only enabled while owner count is zero. Any host-side reset is a separate CLI/maintenance action, not a public HTTP route.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/server test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth apps/server/src/routes apps/server/src/app.ts
git commit -m "feat(auth): add owner bootstrap and sessions"
```

### Task 3: OAuth metadata and dynamic client registration

**Files:**
- Create: `apps/server/src/oauth/metadata.ts`
- Create: `apps/server/src/oauth/client-repository.ts`
- Create: `apps/server/src/oauth/dcr.ts`
- Create: `apps/server/src/oauth/dcr.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: server public base URL, SQLite.
- Produces:
  - `buildAuthorizationServerMetadata(baseUrl: URL): OAuthAuthorizationServerMetadata`
  - `registerOAuthClient(input: DcrRequest): OAuthClientRegistration`
  - routes `/.well-known/oauth-authorization-server` and `/oauth/register`.

- [ ] **Step 1: Write failing DCR tests**

Assert:
- metadata advertises authorization endpoint, token endpoint, registration endpoint, `S256`, token auth method `none`, and `authorization_response_iss_parameter_supported: true`;
- valid public client registration persists exact redirect URIs;
- duplicate equivalent registration returns a new independent client, not accidental shared secrets;
- non-HTTPS redirect URI is rejected except loopback localhost development URI;
- unsupported grants/response types are rejected.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- dcr`

Expected: FAIL.

- [ ] **Step 3: Implement metadata and DCR**

V1 DCR supports public clients only:
- `grant_types: ["authorization_code", "refresh_token"]`
- `response_types: ["code"]`
- `token_endpoint_auth_method: "none"`.

Generate opaque random `client_id`; no client secret for DCR public clients.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/server test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/oauth apps/server/src/app.ts
git commit -m "feat(oauth): add metadata and dynamic registration"
```

### Task 4: OAuth Authorization Code + PKCE and token verification

**Files:**
- Create: `apps/server/src/oauth/model.ts`
- Create: `apps/server/src/oauth/authorization-server.ts`
- Create: `apps/server/src/oauth/token-repository.ts`
- Create: `apps/server/src/oauth/oauth-routes.ts`
- Create: `apps/server/src/oauth/oauth-flow.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: Owner session auth, OAuth clients, SQLite.
- Produces:
  - `GET /oauth/authorize`
  - `POST /oauth/token`
  - `verifyAccessToken(token: string, resource: URL): Promise<AuthInfo>`
  - opaque access/refresh token persistence by verifier/hash.

- [ ] **Step 1: Write failing OAuth flow tests**

Exercise a full browser-less flow:
- unauthenticated authorize request redirects to Owner login;
- authenticated authorize request with exact client redirect URI and S256 challenge yields one-time code;
- wrong redirect URI fails;
- missing/plain PKCE fails;
- code exchange with correct verifier succeeds;
- wrong verifier fails without consuming a valid code incorrectly;
- reused code fails;
- access token is bound to requested `resource` and `mcp` scope;
- refresh token rotates and the old refresh token becomes invalid.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- oauth-flow`

Expected: FAIL.

- [ ] **Step 3: Implement OAuth server integration**

Use `@jmondi/oauth2-server@5` for Authorization Code/PKCE protocol behavior, backed by repository adapters in this task.

Include RFC 9207-style `iss` in authorization responses if metadata advertises issuer identification. Never log codes/tokens.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/server test:run && pnpm --filter @open-desktop-remote/server typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/oauth
git commit -m "feat(oauth): implement authorization code pkce flow"
```

### Task 5: Device pairing lifecycle

**Files:**
- Create: `apps/server/src/devices/device-repository.ts`
- Create: `apps/server/src/devices/pairing-service.ts`
- Create: `apps/server/src/routes/device-pairing.ts`
- Create: `apps/server/src/devices/pairing.test.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: Owner session, SQLite.
- Produces:
  - `createPairing(): { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }`
  - `approvePairing(userCode: string, friendlyName?: string): Device`
  - `pollPairing(deviceCode: string): PairingPollResult`
  - `issueDeviceCredential(deviceId: string): { refreshCredential: string }`.

- [ ] **Step 1: Write failing pairing tests**

Assert:
- user code is short/human-readable and device code is high entropy;
- unapproved poll returns pending;
- expired code returns expired;
- only authenticated Owner can approve;
- approval creates immutable `deviceId`;
- raw long-lived device credential is returned once and only a verifier is stored;
- same user code cannot be approved twice.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- pairing`

Expected: FAIL.

- [ ] **Step 3: Implement pairing service**

Default expiry: 10 minutes. Poll interval: 5 seconds. Use cryptographically random device code and an unambiguous human code alphabet.

- [ ] **Step 4: Run verification**

Run: `pnpm --filter @open-desktop-remote/server test:run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/devices apps/server/src/routes/device-pairing.ts
git commit -m "feat(devices): add self-hosted pairing flow"
```

### Task 6: Device registry, refresh auth, rename and revoke

**Files:**
- Create: `apps/server/src/devices/device-auth.ts`
- Create: `apps/server/src/routes/devices.ts`
- Create: `apps/server/src/devices/device-management.test.ts`
- Modify: `apps/server/src/devices/device-repository.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: paired device credential, Owner session.
- Produces:
  - `DeviceAccessToken = { accessToken: string; expiresAt: number; deviceId: string }`
  - `DevicePrincipal = { deviceId: string }`
  - `refreshDeviceAccess(refreshCredential: string): DeviceAccessToken`
  - `verifyDeviceAccess(accessToken: string): DevicePrincipal`
  - `listDevices()`
  - `renameDevice(deviceId: string, name: string)`
  - `revokeDevice(deviceId: string)`
  - `revokeAllDevices()`.

- [ ] **Step 1: Write failing management tests**

Pin:
- valid refresh credential yields short-lived opaque relay access token;
- invalid/revoked refresh credential fails;
- access-token verification re-checks device revocation;
- Owner can list/rename/revoke;
- revoked device remains in registry with revoked state/history metadata;
- revoke-all invalidates every device;
- `deviceId` never changes when friendly name changes.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @open-desktop-remote/server test:run -- device-management`

Expected: FAIL.

- [ ] **Step 3: Implement device management**

Access token lifetime target: 15 minutes. Refresh credential persists until revoke/rotation.

Do not add online/readiness state to SQLite here; that belongs to Relay memory state in Plan 3.

- [ ] **Step 4: Run full plan verification**

Run: `pnpm test:run && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(devices): add registry credentials and revocation"
```

## Plan 2 Exit Criteria

- A clean Server can initialize exactly one Owner.
- Dashboard session auth works without exposing password/session secrets.
- OAuth metadata, DCR, Authorization Code + PKCE and refresh rotation pass tests.
- Device pairing and credential refresh are fully self-hosted.
- Device registry supports rename, revoke, revoke-all.
- No Relay socket, Agent, Desktop Commander process, or MCP tool execution exists yet.
