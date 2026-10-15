---
name: AI engineering task
about: Optional tracking for cross-session, collaborative, or substantial development tasks
title: "[Task] "
labels: []
assignees: ""
---

## Goal / user-visible result

Use this for substantive, cross-session or public tasks; small local fixes do not need an Issue. Describe the desired behavior and why it matters.

## Scope, non-goals, and ownership

- Expected modules/files:
- Non-goals and must-not-change boundaries:
- Existing implementation, tests, specs or related issues:

## Acceptance criteria

- [ ] AC1: An observable result (not just "code implemented").
- [ ] AC2: Error, authorization, compatibility, or recovery behavior.

## Validation plan / evidence

| Gate | Planned command or scenario | Result / evidence |
| --- | --- | --- |
| Unit / type / contract | | Not run |
| Multi-user / MCP E2E, including deny/refresh/revoke | | Not run |
| Trusted origins, OAuth issuer/resource audience, if affected | | Not run |
| Real Windows / macOS Agent or installer, if affected | | Unverified |
| Agent tag, npm staging + human 2FA, version/checksums, if affected | | Not authorized |
| VPS Nginx, exact image/UI baseline and SQLite rollback, if affected | | Unverified |

## Cross-agent handoff (update during work)

- Current objective:
- Current smallest executable slice:
- Completed changes (branch / Worktree / exact commit):
- Next action and how to verify it:
- Blockers, risks and unverified scenarios:

**Public Issue privacy rule:** Use sanitized descriptions only. Do not paste personal names/contact details, identifiable device data, VPS addresses, SSH usernames/endpoints, internal topology, production configuration, unredacted screenshots, logs, credentials or tool payloads. Keep real operations records outside GitHub.
