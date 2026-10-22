# OpenRemoteDesktop — AI engineering rules

These rules apply to the public **OpenRemoteDesktop** Git repository (`Chajian/openremotedesktop`). Work only within this repository's verified source, existing architecture, and explicitly authorized deployment environment.

## Canonical instructions and reading order

- This `AGENTS.md` is the single project-level instruction source for Codex and Claude. `CLAUDE.md` contains only `@AGENTS.md`; do not duplicate behavioral rules in model-specific documents.
- On a new task: read this file, inspect `git status --short --branch`, branch/HEAD and worktrees, then read only the relevant files, tests and architecture sections. Do not load all specs and history upfront.
- [AI workflow](docs/ai-project-management.zh-CN.md) governs collaboration; [current architecture](docs/architecture.md), [protocol](docs/protocol.md), [security](docs/security.md), [repository safeguards](docs/repository-security.zh-CN.md), [dual-domain deployment](docs/dual-domain-github-mcp.zh-CN.md) and [Agent release](docs/agent-github-actions.zh-CN.md) contain domain-specific requirements. Read only documents relevant to the change.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` are dated design inputs, not live implementation state. For conflicting claims, inspect current source and tests; for deployed behavior, verify the running image, configuration and real endpoint. Never infer the production baseline from `master` or an old document alone.

## Architecture and ownership

- `apps/server/`: self-hosted HTTP/OAuth and optional GitHub sign-in, legacy local Owner, per-user OAuth approvals/device authorization, relay routing, Dashboard and persistent SQLite state. Server-enforced ownership is mandatory; a GitHub login is not an MCP authorization grant.
- `apps/agent/`: outbound-only WSS Agent, device pairing and protected credentials, process lifecycle, Desktop Commander stdio bridge, reconnect, deduplication and execution-state reporting.
- `packages/protocol/` and `packages/shared/`: shared wire contracts and types; update both producer and consumer with compatibility tests for contract changes.
- `packages/tool-contracts/`: pure generated Desktop Commander tool catalog and remote schema helpers; no executor or upstream runtime dependency.
- `packages/desktop-commander-adapter/`: pinned upstream Desktop Commander stdio integration and source-compatible catalog re-exports. Do not fork or reimplement Desktop Commander core merely to add an OpenRemoteDesktop capability.
- `scripts/`, `docker/`, `.github/workflows/`: installers, packaging, deployment and release automation. Avoid changing release and production defaults as a side effect of an unrelated feature.

## Invariants that must not regress

- Only a READY, authorized device may receive tool calls; one user's devices, OAuth clients, sessions and data must not leak to another user. OAuth consent, CSRF, token expiry/rotation and revoke semantics remain enforced.
- Agent connections are outbound only; never open new inbound workstation ports or expose a raw shell/stdin interface publicly.
- Network ambiguity after dispatch must remain `EXECUTION_UNKNOWN`, never automatic replay of side-effecting tool commands. Observe actual device state before retrying.
- Default logs must not contain tool bodies, file contents, credentials or token values. Never introduce real credentials, private IP addresses, personal devices, local `.env`, databases, logs or secret material into this public repository.
- Multi-domain changes must preserve the existing OAuth issuer, existing device credentials and grants, and resource-bound MCP tokens. Only explicitly trusted public origins may determine GitHub callback/resource URLs; cookies remain origin-scoped. Cross-origin tokens cannot be silently accepted. See [dual-domain deployment requirements](docs/dual-domain-github-mcp.zh-CN.md).
- The existing deployment runbook describes a VPS/Nginx topology; verify the real environment before relying on it. Repository Docker Compose/Caddy is a reference, not permission to replace the running stack. Confirm the actual deployed Server image, Dashboard routes, Agent connections, HTTPS origins and SQLite backup/restore before changing production. Do not overwrite production from `master` merely because tests pass. Preserve install feature flag default-off; see [deployment gate](docs/dual-domain-github-mcp.zh-CN.md).
- A passing mock or static test is not real Windows/macOS install, device pairing, READY, production deployment or rollback acceptance.
- **Public repository privacy:** Never commit personal contact details, real device identities, private server inventories, actual VPS IP addresses, remote-login details, production environment files or unredacted diagnostic evidence. Use sanitized example values; refer to [privacy and infrastructure disclosure rules](docs/repository-security.zh-CN.md).

## Changes, worktrees and review

- Define the task's objective, non-goals, expected files, compatibility risks and observable acceptance criteria before implementing changes. Prefer the smallest change consistent with the existing architecture.
- A GitHub Issue is **optional**, useful for public collaboration, substantial cross-session work or long-running bugs; never require one for a small local fix. Use the [Issue template](.github/ISSUE_TEMPLATE/ai-task.md) when needed and the [PR checklist](.github/pull_request_template.md) when opening a PR. Keep handoff in the existing Issue/PR or local task context without duplicating status files. Public issues must not contain private device/deployment details.
- Use a dedicated branch/worktree for concurrent AI work. Preserve unrelated dirty changes. Do not stage unrelated files, bulk reset, rewrite history, force-push, merge or publish without appropriate authorization.
- Codex and Claude are interchangeable executors, not separate sources of truth. A handoff must identify branch, exact commit, current slice, completed work, verification evidence, blockers and next action.
- Maintain or update the existing authoritative document when behavior changes. Keep process notes compact; create ADR/spec/plan only for cross-cutting decisions that truly need a durable record.

## Verification and deployment gates

- Required for governance/docs edits: `pnpm governance:check`, relevant Markdown/link checks and `git diff --check`; use the affected code checks only as needed.
- For application/contract changes: run `pnpm test:run`, `pnpm typecheck`, and `pnpm test:e2e` when relevant; report which commands were actually run. Protocol/authorization changes require negative and cross-user tests.
- For Agent/installer/packaging changes: run the relevant platform matrix from `.github/workflows/agent-smoke.yml`; actual Windows/macOS install, upgrade, recovery and device READY tests require separate live evidence.
- **Release gate:** only authorized version tags from reviewed `master` may trigger staged npm publishing; never bypass human npm 2FA approval. The versioned Agent package, installers and Server-hosted installer script must be compatible and traceable to reviewed sources. Keep `ODR_AGENT_INSTALL_ENABLED` off until the matching npm version is public, checksums/URLs are verified, and clean Windows/macOS pairing reaches READY. See [onboarding](docs/one-command-onboarding.md) and [npm workflow](docs/agent-github-actions.zh-CN.md).
- Before any commit: inspect staged diff and run `node scripts/check-source-hygiene.mjs --staged` plus `node scripts/check-privacy-additions.mjs --staged`. Before push/release: run the history scan and privacy branch check, then follow CI, release verification and operator approval gates.
- Never report success for checks that were skipped or failed. Explicitly distinguish static checks, simulated/e2e tests, real device verification and remote production operation.
