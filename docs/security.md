# Security model

## Trusted components

The self-hosted Server is part of the trusted computing boundary.

It terminates TLS through the reverse proxy, authenticates users/devices and sees tool payloads while forwarding them. V1 does not use application-level end-to-end encryption to hide those payloads from the Server operator.

OpenAI or another selected AI provider may receive tool inputs and results because they are part of the model conversation.

## Default data handling

Normal Server logs are metadata-only. They may include request ID, device ID, tool name, duration, success/failure, stable error code, and connection events.

Normal logs must not include tool arguments, file content, screenshots, shell stdout/stderr bodies, Owner passwords, OAuth authorization codes, access/refresh tokens, or device refresh credentials.

`DEBUG_PAYLOAD_LOGGING=true` deliberately weakens this guarantee and prints a warning. Do not enable it on a Server whose logs are exported to third parties unless that is intentional.

Tool payload bodies and Desktop Commander results are not persisted to SQLite by default.

Operation recovery adds SQLite metadata (user/client/device IDs, process epoch,
tool name, timestamps, outcome and terminal response digest) with 24-hour retention.
Arguments, human-readable error bodies and results remain excluded. The Agent
keeps result bodies in bounded process memory with a 15-minute query expiry after
completion. Expired entries are reclaimed lazily on store access; this is not a
memory-zeroization deadline. There is no durable result backup. Metadata-only
queries omit the body and do not extend retention.

## Credentials and OAuth

Owner passwords use a salted scrypt hash.

Dashboard sessions, OAuth bearer/refresh tokens and device credentials are represented server-side by non-reversible verifier/hash material rather than raw long-lived secrets.

OAuth uses:

- Authorization Code;
- PKCE S256;
- exact registered redirect URI matching;
- one-time authorization codes;
- opaque access and refresh tokens;
- refresh-token rotation;
- resource binding to the MCP endpoint;
- `mcp` and `offline_access` scopes.

Device pairing uses a high-entropy machine code plus a short human confirmation code.

## Authorized MCP clients

Dynamic client registration creates only an OAuth client ID; it does not grant
permission to execute tools. The Owner must explicitly approve the client
during OAuth Authorization Code + PKCE consent. Each MCP request checks both
the access token and its client authorization record.

The Owner Dashboard lists approved clients and can revoke an individual client.
Revocation invalidates its existing access tokens, refresh tokens, and unused
authorization codes. The client can reconnect only after explicit new consent.
Existing approved clients are preserved during the V4 database migration.

Bearer tokens authorize their **holder**, not a cryptographically verified
individual ChatGPT conversation. One ChatGPT connection may be used from more
than one chat, and a stolen unexpired bearer token could be replayed.
Keep the tokens secret, use HTTPS, and revoke the affected client if compromised.

## Device authority

Desktop Commander executes under the OS account that started the Agent. If that account can read, write, launch or delete something, a remote tool may potentially do the same.

Do not treat Desktop Commander's `allowedDirectories` or blocked-command configuration as a complete security sandbox, especially for shell/process tools.

For stronger isolation, use one or more of:

- a dedicated low-privilege OS user;
- a VM containing only the project/workspace you intend to expose;
- a container where the required tools actually work;
- separate machines for sensitive and experimental work.

## Network exposure

A normal Agent opens no inbound port. It makes an outbound WSS connection to the self-hosted Server.

The reference deployment publicly exposes only 80/443 through Caddy. Server port 3000 and SQLite are internal.

Do not expose the Agent's Desktop Commander stdio process or a raw shell port to the internet.

## Revocation

Revoking a device invalidates its server-side device credentials/tokens for new authentication.

Revocation cannot undo actions already executed and cannot erase a copied credential from a compromised machine. If compromise is suspected, revoke the device, rotate the Owner passphrase if appropriate, and inspect the host.

## Device deletion

Account owners can delete a device separately from revoking it. Deletion
sets a non-reversible `deleted_at` tombstone and revokes both refresh
credentials and short-lived access tokens in one database transaction.
An online Relay socket is detached and closed, while pending remote tool
calls are classified as ambiguous if already dispatched. Deleted devices
are excluded from account lists and MCP discovery, including the revoked
devices filter. Old Agent credentials cannot restore access.

The tombstone retains only its device ID, owner relationship and required
lifecycle timestamps so operation-history references remain stable; names,
platform/version metadata and last-seen information are scrubbed. Separate
minimal deletion audit events are purged after 30 days by default, adjustable
using `ODR_DEVICE_DELETION_AUDIT_RETENTION_DAYS` (1..3650). No tool bodies
or customer file contents are stored by deletion.

Deployment/rollback: take a SQLite backup before the migration (V7 adds an
optional `deleted_at` field and an audit table). Rolling back Server
binaries alone cannot restore revoked credentials; older binaries may show
a scrubbed tombstone as a revoked device because they do not filter
`deleted_at`. Prefer a forward fix over restoring historical credentials.
Never restore a database backup over newer legitimate authorization changes.

## Temporary remote support (feature-gated pilot)

`ODR_SUPPORT_ENABLED` defaults to `false`. The pilot requires a
compatible Windows Agent; the existing published 0.1.3 client does not
automatically support `agent support`. Do not enable customer invitations
until the matching Agent distribution has been built and verified.

When a verified compatible npm Agent version is configured with
\`ODR_SUPPORT_AGENT_VERSION\` and the official installer is enabled, the customer
page offers a checksum-pinned HTTPS PowerShell installer. Otherwise it labels
the source-checkout command as developer-only. The original published Agent
version must not be misrepresented as supporting this command.

An authenticated account owner creates a session. The one-time invitation is
192 bits of randomness, stored only as its SHA-256 hash, expires after five
minutes, and can be redeemed once without customer account creation. The
customer's Agent must explicitly approve full tool access before redeeming it.
Once joined, the temporary device inherits the creator account's authorized
MCP clients, including multiple AI clients; it does not bypass the platform's
own consent prompts.

A joined session is not timed out automatically. The creator ends it in
Dashboard or the customer can press Ctrl+C in the Agent's terminal to stop
sharing; the customer stop endpoint verifies that device's refresh credential.
Both revoke all device credentials, detach the live Relay socket and prevent
new requests. A credential-possessor may query only the session's terminal
state and reason after revocation via POST /api/support/status; this grants
no tool access. The Agent reports a normal exit only when an owner-ended
state is verified after credential rejection and runtime shutdown succeeds.
Other authentication, transport and executor-cleanup failures remain errors.
The refresh credential issuance and active-credential lookup are shared with
normal device pairing in a small device-credential component.
If the Agent crashes or loses network connectivity, the session
is left offline for the creator to end, not silently deleted. The temporary
credential lives only in process memory, never in the durable OS keyring or
credential file. Direct device deletion also makes its support session appear
ended. Past side-effects cannot be undone by revocation.

The server remains a trusted component and can read command contents, as in
ordinary device mode. No GUI automation guarantee is implied by Desktop
Commander tools. Invitation URLs must not be sent to analytics or third-party
resources; customer pages use no-referrer and no-store headers. A customer
installation distribution and signed Windows binary are still release gates,
not proven by automated mocks or source-checkout tests.

## Ambiguous execution

A network loss can occur after a side-effecting command ran but before its result reached the Server. Open Desktop Remote reports this as `EXECUTION_UNKNOWN` and does not automatically repeat the call.

Before retrying a mutation after this error, inspect the resulting state.

When the error includes a recovery-capable operation ID, the original authorized
MCP client can first call `odr_get_operation`. Its query component cannot submit or
execute a tool. A result is available only while the Agent process and cached body
survive. Missing, expired, evicted and restarted states never grant execution rights.

Recovery requires the original requesting user and OAuth client, current device
ownership and current token/grant authorization, including the original resource
audience. Both invocation and query revalidate access after waiting before
delivering a result. Unauthorized and nonexistent operations have the same query
response. A different chat using the same authorized client/token is not a separate
security principal; the existing bearer-token boundary still applies.

Relay results are bound to the authenticated current socket and negotiated Agent
process identity. Query replies additionally match a separate query ID. Conflicting
terminal evidence is recorded and its payload withheld. Cancellation is a request,
not proof of nonexecution or rollback.

If the Server's metadata database fails while a correlated, authenticated result
is being delivered, the Broker does not close the Relay as a protocol violation.
It can deliver the pending result while logging an evidence-store failure; a
later recovery query may need to reconcile missing terminal metadata. No result
body is added to SQLite as part of this fallback. Hung local execution is
handled by a bounded executor recycle, never by an automatic mutation retry.

## MCP client safety

Only connect MCP clients you trust to your Server and only publish the custom app to users who should have the underlying machine authority.

Model/tool prompt injection remains relevant: content read from files or external URLs can influence an AI model. Human confirmation controls offered by an MCP client are useful but are not a substitute for OS-level isolation.

## Debugging and reports

Do not include production credentials or sensitive payloads in bug reports. Reproduce with a disposable directory and scrub Server/Agent logs first.
