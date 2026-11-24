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
- Firefox 142.0.1: PASS after importing a disposable fixture CA into a dedicated NSS certificate database. Three real loopback HTTPS origins on distinct ports used valid fixture TLS with certificate verification enabled. Single 302 and chained 302 both reached their expected destinations. Automatic and manual navigation using the actual callback page renderer reached the final origin with the original code, state (including Unicode and quotes), issuer and no Referer. The earlier intercepted-network and unknown-issuer fixture failures are superseded by this direct HTTPS experiment. The Chrome-specific CSP failure is a browser behavior difference, not a confirmed Google redirect chain.
- Added a dedicated Gemini OAuth-to-real-Agent E2E test. A synthetic registered Google callback is approved using the existing consent path; the HTTP 200 link provides the original authorization code, and PKCE exchange succeeds. The existing MCP client connects, discovers both device tools, waits for the independently paired real Agent to reach READY and queries its status. The fixture never navigates to Google and is not a real Gemini Connected App.
- Final E2E suite: 29/29 PASS, including this new end-to-end test. An initialize request with the usual MCP Accept header returned `text/event-stream`.
- Actual Gemini, ChatGPT, Codex, Claude and Grok integrations: NOT_TESTED. The tests use isolated databases and synthetic clients, not production accounts, tokens or devices.

## Remaining gates

Status: IMPLEMENTED / local review candidate. Not READY_FOR_PRODUCTION_REVIEW and not DEPLOYED. A real public HTTPS test instance with an independent issuer, MCP resource, database, user, device and Relay is required.

Staging preflight: the candidate source was exported from the verified baseline with the reviewed source blobs. A separate Linux test image build was attempted, but the operating system package download encountered proxy/socket resource failures; the isolated build was stopped to avoid stressing other workloads. No candidate Linux image or public test instance was created. The local E2E test above provides isolated Server and real Agent evidence, not public deployment acceptance.

A Cloudflare Quick Tunnel is unsuitable for the full MCP acceptance because its documented limitations exclude SSE, whereas the tested MCP initialize response uses `text/event-stream`. Use a dedicated named tunnel or another explicitly authorized HTTPS reverse proxy that preserves SSE, and do not reuse unrelated tunnel credentials or change production ingress. Before exposing the staging service, initialize the independent Owner locally, verify anonymous requests are challenged, and use a disposable, least-privileged test Agent without host filesystem mounts or access to production data. No public staging hostname or tunnel authorization was available during this run.

Complete Gemini consent with explicit user action, then verify token exchange, initialize, tools/list, list_devices and get_device_status. Confirm the other platforms separately. Investigate the existing Agent test failures or explicitly assess and accept their risk before declaring full regression success.

### Named tunnel connectivity follow-up

- The dedicated remotely managed test tunnel was created through the operator's authenticated Cloudflare session. A locally supplied scoped tunnel token passed the expected tunnel-ID check. The isolated Windows Server started, initialized a new Owner, published the independent issuer and returned HTTP 401 to anonymous MCP access.
- The real connector could not register at the Cloudflare edge. QUIC attempts timed out; the automatic HTTP/2 fallback also failed with TLS handshake EOF. No registered tunnel connection was observed. A public DNS query returned NXDOMAIN for the proposed staging hostname. Real Gemini OAuth/MCP acceptance is still NOT_TESTED.
- A verified TLS probe using the upstream cloudflared CA bundle and the official HTTP/2 server name reproduced the failure on the first Windows host. A second Windows test host and an available Linux test host each verified TLS 1.3 to both sampled edge endpoints. These are transport prerequisites, not proof of authenticated tunnel registration. No certificate validation or network security control was disabled.
- The first staging Server and its own connector were stopped; the launcher removed the isolated SQLite database and logs. The staging port was free, and the production health endpoint returned HTTP 200.
- On the alternate Windows test host, the reviewed runtime source blobs matched the candidate, and a fresh isolated local instance passed HTTP 200 health, HTTP 201 temporary Owner creation, issuer equality and HTTP 401 anonymous MCP checks. The instance and its temporary database were removed after preflight.
- BLOCKED: public route configuration and connector authorization on the alternate host remain outstanding. The original connector's token was discarded with the process; do not recover credentials from process memory or unrelated services. The authenticated browser context was unavailable for Cloudflare management. The existing dedicated cloud tunnel is accounted for but its cloud-side deletion is not verified. Preserve the cleanup requirement and do not mark the task closed or ready for production.

## Temporary staging lifecycle (required)

The isolated public Gemini acceptance environment is disposable, not a second production service. A proposed dedicated hostname is subject to an authorized DNS availability check. Use only separately owned staging ingress, Server, database, Owner, OAuth clients, Agent and Relay; no production identity or data may be copied. Do not expose a host filesystem or reuse another service's tunnel credentials.

Record the exact staging resource identifiers and ownership before creation, and prepare narrowly scoped teardown commands before opening the ingress. Set an explicit test deadline (maximum 24 hours per session); any extension requires an explicit operator decision. On successful acceptance, cancellation, failure or expiry:

1. Preserve only sanitized validation evidence and reviewed source commits. Disconnect the test Connected App using the platform's own controls; never revoke an existing production grant.
2. Disable the dedicated public route and stop the staging Agent, Relay, Server and tunnel. Delete only the DNS record, tunnel, route and scoped credentials created for this test.
3. Remove the staging containers, volumes, SQLite database (including WAL/SHM), ephemeral tokens, test certificates/keys, private browser profiles, downloaded test dependencies, build context, temporary images and staging directories attributable to this task. Keep the development branch/worktree and shared base images/dependencies; do not run global Docker, Git or filesystem cleanup.
4. Verify the staging hostname/route is gone at the DNS provider, ingress is inaccessible, and the recorded staging processes, containers, volumes, credentials and files no longer exist. DNS caches may require expiry before public NXDOMAIN is observable. Verify production health and existing device connections without restarting or modifying production.
5. Record the cleanup result and any resource that could not be removed. The acceptance task is not closed while a temporary resource remains unaccounted for.

Do not create an unattended persistent public instance if the operator cannot complete platform authorization or guarantee teardown. A staging PASS is separate from approval to release the production Server.

## Release and rollback preparation (not authorization)

1. Verify the actual deployed image/commit, startup configuration, trusted public origins, reverse proxy/CSP headers and active Relay/operation inventory. Do not infer this from the Git baseline. Capture restorable image and configuration references, and back up the database according to the existing deployment runbook.
2. Build the reviewed candidate image; deploy first with the feature flag off only after separate production approval. Do not overwrite the database or change the issuer. Check health, existing OAuth and device connectivity. Account for Server restart disconnecting Relay sessions; do not replay dispatched side-effecting operations.
3. After separate approval, enable the flag and verify real Gemini and existing clients. The flag is loaded at startup; changing it requires restarting the Server process. Monitor OAuth response status, token exchange, MCP initialization and Agent readiness without logging sensitive OAuth parameters.
4. On unexpected non-Gemini behavior, failed authorization, unsafe callback handling, or unstable Relay recovery, disable the flag and restart during a controlled window. If necessary, restore the previous image and configuration. Preserve the current database and post-deployment legitimate user/authorization/device state; database restoration is not the normal rollback path.

No production deployment, credential reuse, device revocation, push or merge was performed.

- Final Server rerun on matching source blobs: 442/442 PASS. Final server typecheck: PASS. Actual Gemini platform validation remains NOT_TESTED.
