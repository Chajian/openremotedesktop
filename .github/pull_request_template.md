## Purpose and linked issue

- Linked issue:
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
| `pnpm test:e2e` / auth and device isolation | | |
| Windows, macOS, Linux Agent smoke if affected | | |
| Real device install / pairing / READY / upgrade if affected | | |
| `node scripts/check-source-hygiene.mjs --staged` | | |

## Risks, rollback, and remaining work

- What could break, including privacy and auth boundaries:
- Rollback or recovery plan:
- Failed or unverified checks (never describe these as passed):
- Release or deployment authorization, if needed:

## Handoff

- Branch and exact commit:
- Current slice / next actionable step:
