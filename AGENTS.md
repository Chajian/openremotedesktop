# OpenRemoteDesktop — AI engineering rules

These rules apply to the **OpenRemoteDesktop** Git repository (`Chajian/openremotedesktop`). This project is NOT TokenHub. Never assume TokenHub's architecture, GitLab workflow, secrets exceptions, or source paths apply here.

## Canonical instructions and reading order

- This `AGENTS.md` is the single project-level instruction source for Codex and Claude. `CLAUDE.md` contains only `@AGENTS.md`; do not duplicate behavioral rules in model-specific documents.
- On a new task: read this file, inspect `git status --short --branch`, branch/HEAD and worktrees, then read only the relevant files, tests and architecture sections. Do not load all specs and history upfront.
- [AI task lifecycle](docs/ai-project-management.zh-CN.md) is the process reference; [architecture](docs/architecture.md), [security](docs/security.md), [protocol](docs/protocol.md) and [repository safeguards](docs/repository-security.zh-CN.md) own their respective technical details.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` contain dated design inputs. A plan, an old approval or a previous test result is not proof that the current branch or deployment implements it.

## Architecture and ownership

- `apps/server/`: self-hosted HTTP/OAuth/GitHub identity, Owner consent, tenant/device authorization, relay routing, Dashboard and persistent SQLite state. Keep identities and authorization server-authoritative.
- `apps/agent/`: outbound-only WSS Agent, device pairing and protected credentials, process lifecycle, Desktop Commander stdio bridge, reconnect, deduplication and execution-state reporting.
- `packages/protocol/` and `packages/shared/`: shared wire contracts and types; update both producer and consumer with compatibility tests for contract changes.
- `packages/desktop-commander-adapter/`: pinned upstream Desktop Commander integration and generated tool contract. Do not fork or reimplement Desktop Commander core merely to add an OpenRemoteDesktop capability.
- `scripts/`, `docker/`, `.github/workflows/`: installers, packaging, deployment and release automation. Avoid changing release and production defaults as a side effect of an unrelated feature.

## Invariants that must not regress

- Only a READY, authorized device may receive tool calls; one user's devices, OAuth clients, sessions and data must not leak to another user. OAuth consent, CSRF, token expiry/rotation and revoke semantics remain enforced.
- Agent connections are outbound only; never open new inbound workstation ports or expose a raw shell/stdin interface publicly.
- Network ambiguity after dispatch must remain `EXECUTION_UNKNOWN`, never automatic replay of side-effecting tool commands. Observe actual device state before retrying.
- Default logs must not contain tool bodies, file contents, credentials or token values. Never introduce real credentials, private IP addresses, personal devices, local `.env`, databases, logs or secret material into this public repository.
- Preserve existing Docker/HTTPS origin and installation defaults unless the task explicitly authorizes their change. A passing mock or static test is not real Windows/macOS install, device pairing, READY, production deployment or rollback acceptance.

## Changes, worktrees and review

- Define the task's objective, non-goals, expected files, compatibility risks and observable acceptance criteria before implementing changes. Prefer the smallest change consistent with the existing architecture.
- GitHub Issues and Pull Requests are the primary task/status and review records. Use [.github issue template](.github/ISSUE_TEMPLATE/ai-task.md) and [PR checklist](.github/pull_request_template.md); do not create a separate per-chat status file or parallel issue tracker.
- Use a dedicated branch/worktree for concurrent AI work. Preserve unrelated dirty changes. Do not stage unrelated files, bulk reset, rewrite history, force-push, merge or publish without appropriate authorization.
- Codex and Claude are interchangeable executors, not separate sources of truth. A handoff must identify branch, exact commit, current slice, completed work, verification evidence, blockers and next action.
- Maintain or update the existing authoritative document when behavior changes. Keep process notes compact; create ADR/spec/plan only for cross-cutting decisions that truly need a durable record.

## Verification and deployment gates

- Required for governance/docs edits: `pnpm governance:check`, relevant Markdown/link checks and `git diff --check`; use the affected code checks only as needed.
- For application/contract changes: run `pnpm test:run`, `pnpm typecheck`, and `pnpm test:e2e` when relevant; report which commands were actually run. Protocol/authorization changes require negative and cross-user tests.
- For Agent/installer/packaging changes: run the relevant platform matrix from `.github/workflows/agent-smoke.yml`; actual Windows/macOS install, upgrade, recovery and device READY tests require separate live evidence.
- Before any commit: inspect staged diff and run `node scripts/check-source-hygiene.mjs --staged`. Before push/release: follow the existing history scan, CI, release verification and operator approval gates.
- Never report success for checks that were skipped or failed. Explicitly distinguish static checks, simulated/e2e tests, real device verification and remote production operation.
