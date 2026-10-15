## Purpose (issue optional)

- Linked issue, if one exists:
- User-visible outcome and reason:

## Change scope

- Modules/files changed:
- Intentionally unchanged areas:
- Contract, permissions, security, migration or release impact:

## Verification (actual commands and results)

| Check | Result (pass / fail / not run) | Evidence / environment |
| --- | --- | --- |
| `pnpm governance:check` | | |
| `pnpm test:run` / targeted unit checks | | |
| `pnpm typecheck` | | |
| `pnpm test:e2e` / auth, OAuth audience and device isolation | | |
| Windows, macOS, Linux Agent smoke if affected | | |
| Real device install / pairing / READY / upgrade if affected | | |
| Dual-domain issuer/resource, deployed UI baseline and SQLite backup if affected | | |
| Agent version/tag and npm staged 2FA / public availability if releasing | | |
| Install-flag default OFF, matching scripts/checksums if releasing | | |
| `node scripts/check-source-hygiene.mjs --staged` | | |

## Risks, rollback, and remaining work

- What could break, including privacy and auth boundaries:
- Rollback or recovery plan:
- Failed or unverified checks (never describe these as passed):
- Release or deployment authorization, if needed (not implied by PR approval):
- Real staging/production checks are not covered by mocked or static CI:
- [ ] Privacy review: the diff, commit messages, PR body, screenshots and CI artifacts contain no personal identifiers, private device details, VPS IPs, SSH endpoints, private deployment inventory or sensitive logs.
- [ ] Any retained endpoint is an intentionally public product address; examples use reserved placeholders.

## Handoff

- Branch and exact commit:
- Current slice / next actionable step:
