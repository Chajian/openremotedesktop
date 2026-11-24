# Gemini OAuth callback compatibility (Issue #22)

## Scope and behavior

Baseline: `2ee9aeead7b117c03ff636873d86c55fe2216504`.

The existing OAuth consent validation, code issuance, issuer append, client approval and token exchange remain authoritative. A default-off flag, `ODR_GEMINI_CALLBACK_COMPAT_ENABLED`, selects an HTTP 200 navigation page only after a validated consent POST for the exact HTTPS Google callback origin and supported `/r/` path. Approval and denial retain their original callback parameters. A malformed or inconsistent final Location fails closed. Other clients and flag-off requests retain HTTP 302 behavior.

See [security model](security.md) for the security contract. No schema, Agent, Relay, MCP protocol, token endpoint or production dependency changes are included.

## Validation evidence (2026-11-24)

- Real Chrome 156.0.8078.80 on Windows, disposable browser profile. The repeatable `scripts/test-gemini-callback-browser.mjs` fixture supplies synthetic HTTP responses for three reserved HTTPS origins through CDP interception, not actual TLS/network servers. No CSP or certificate validation was disabled.
- Single consent POST → 302 → B: PASS.
- Consent POST → 302 → B → 302 → C: reproduction PASS. B received the synthetic callback, C did not, and Chromium reported the same `form-action` violation pattern as Issue #22. The navigation remained at A.
- Consent POST → 200 HTML → independent automatic navigation → B → C: PASS. The synthetic code, state and issuer parameters reached C intact.
- Manual navigation fallback with automatic refresh omitted: PASS. This is mechanism evidence, not proof that Google actually performs the second hop.
- Focused OAuth tests: 28/28 PASS (callback strategy, HTML escaping, approval/denial, flag-off/nonmatching clients, CSRF, exact URI/resource, PKCE, code expiry/single-use and refresh rotation). The two additional security cases were run after the first full suite.
- Recursive TypeScript checks: PASS on all six workspace packages.
- First complete workspace run: 875 passed, 2 failed, 2 skipped. Server 440/440 passed. Both failures were existing Agent HTTP/WebSocket integration tests. No Agent or shared package changes. A targeted candidate rerun of the two files produced 26 failures/14 passes; a clean checkout of the exact unchanged baseline reproduced failures in both files (17 failed/23 passed). Results vary between runs; the full-suite gate remains FAIL, and the Agent issue is outside this change.
- MCP E2E: 28/28 PASS, including isolated real transport and subprocess scenarios.
- Governance: 14/14 PASS and document structure check PASS.
- Firefox 142.0.1: BLOCKED / not validated. Redirect interception did not capture the complete chain; a separate real loopback HTTPS attempt failed with SEC_ERROR_UNKNOWN_ISSUER before reaching consent. No certificate-verification bypass was used. This is a fixture/trust failure, not evidence of product incompatibility.
- Actual Gemini, ChatGPT, Codex, Claude and Grok integrations: NOT_TESTED. The tests use isolated databases and synthetic clients, not production accounts, tokens or devices.

## Remaining gates

Status: IMPLEMENTED / local review candidate. Not READY_FOR_PRODUCTION_REVIEW and not DEPLOYED. A real public HTTPS test instance with an independent issuer, MCP resource, database, user, device and Relay is required. Complete Gemini consent with explicit user action, then verify token exchange, initialize, tools/list, list_devices and get_device_status. Confirm the other platforms separately. Investigate the existing Agent test failures or explicitly assess and accept their risk before declaring full regression success.

## Release and rollback preparation (not authorization)

1. Verify the actual deployed image/commit, startup configuration, trusted public origins, reverse proxy/CSP headers and active Relay/operation inventory. Do not infer this from the Git baseline. Capture restorable image and configuration references, and back up the database according to the existing deployment runbook.
2. Build the reviewed candidate image; deploy first with the feature flag off only after separate production approval. Do not overwrite the database or change the issuer. Check health, existing OAuth and device connectivity. Account for Server restart disconnecting Relay sessions; do not replay dispatched side-effecting operations.
3. After separate approval, enable the flag and verify real Gemini and existing clients. The flag is loaded at startup; changing it requires restarting the Server process. Monitor OAuth response status, token exchange, MCP initialization and Agent readiness without logging sensitive OAuth parameters.
4. On unexpected non-Gemini behavior, failed authorization, unsafe callback handling, or unstable Relay recovery, disable the flag and restart during a controlled window. If necessary, restore the previous image and configuration. Preserve the current database and post-deployment legitimate user/authorization/device state; database restoration is not the normal rollback path.

No production deployment, credential reuse, device revocation, push or merge was performed.

- Final Server rerun on matching source blobs: 442/442 PASS. Final server typecheck: PASS. Actual Gemini platform validation remains NOT_TESTED.
