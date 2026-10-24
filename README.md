# OpenRemoteDesktop

Project website: https://openremotedesktop.com

OpenRemoteDesktop is an open-source, self-hosted remote-control layer for Desktop Commander. It keeps the useful Desktop Commander Remote workflow — ChatGPT or another MCP client can select one of your computers and call Desktop Commander tools there — without requiring a service operated by this project's maintainers.

The server supports a legacy single-owner mode as well as GitHub identities and per-user device/MCP client isolation. See [Multi-user + GitHub setup (Chinese)](docs/multi-user-github.zh-CN.md) before upgrading a legacy deployment. The server remains self-hosted, and Agents establish outbound-only connections.

## What V1 provides

- Standard remote MCP over Streamable HTTP at `/mcp`.
- Built-in OAuth Authorization Code + PKCE, DCR, refresh-token rotation, and `offline_access`.
- Explicit Owner consent for each OAuth client; Dashboard lists authorized clients
  and can immediately revoke their access and refresh tokens.
- Multiple devices for one owner, with stable device IDs, friendly names, READY state, rename and revoke.
- Outbound-only Agent relay over WSS; no inbound workstation ports are required.
- Local Desktop Commander `0.3.1` through stdio; its filesystem, process, search and document tools remain local.
- Safe ambiguous-delivery behavior: a dispatched request is never silently replayed after a disconnect.
- Minimal owner Dashboard, SQLite persistence, privacy-safe default logging, Docker Compose and Caddy.
- Windows, macOS and Linux Agent target; Linux/Docker Server target.

## Trust model

Your self-hosted Server is trusted and can see tool payloads while relaying them. By default, payload bodies are not persisted to SQLite or normal logs, and no telemetry is sent to this project's maintainers. OpenAI or another model provider still receives the tool inputs/results needed by the AI workflow.

The Agent runs Desktop Commander with the permissions of the OS account that starts it. Desktop Commander's directory settings are useful controls, but this project does not present them as a complete sandbox.

## Prerequisites

For production self-hosting:

- A Linux host or VPS with Docker Engine + Docker Compose.
- A public DNS name pointing at that host.
- TCP 80/443 reachable by Caddy for certificate issuance and HTTPS.
- On each controlled computer: Node.js 24+ and pnpm/Corepack.

For source development, Node.js 24 and pnpm 10.12.3 are the tested baseline.

## Production quick start

Clone the repository on the Server:

```bash
git clone https://github.com/Chajian/openremotedesktop.git
cd openremotedesktop
cp .env.example .env
```

Edit `.env`:

```dotenv
ODR_DOMAIN=remote.example.com
DEBUG_PAYLOAD_LOGGING=false
```

Start the stack:

```bash
docker compose up -d --build
docker compose ps
```

The public MCP endpoint is then:

```text
https://remote.example.com/mcp
```

### Bootstrap the single Owner

Bootstrap exists only while no Owner exists:

```bash
curl -X POST https://remote.example.com/api/bootstrap \
  -H "content-type: application/json" \
  --data '{"password":"replace-with-a-long-owner-passphrase"}'
```

After bootstrap succeeds, the public bootstrap endpoint refuses a second owner. Open:

```text
https://remote.example.com/dashboard/login
```

and sign in with the Owner passphrase.

## Agent npm distribution (staged releases)

The experimental Windows/macOS bootstrap scripts are in `scripts/`. When a
`agent-v*` tag passes tests, GitHub Actions automatically creates a GitHub Release
containing the npm tarball, installers, instructions and SHA-256 checksums.
The separate npm package release still requires human 2FA approval; it is
**not automatically made public on npm** by the CI workflow.
See [GitHub Actions + npm Trusted Publisher setup](docs/agent-github-actions.zh-CN.md).
Until the npm release is approved and clean-machine installs are validated, use
the following source/developer method.

## Start and pair an Agent

On a Windows, macOS or Linux computer you want ChatGPT to control:

```bash
git clone https://github.com/Chajian/openremotedesktop.git
cd openremotedesktop
corepack enable
pnpm --filter @open-desktop-remote/agent... install --frozen-lockfile
pnpm --filter @open-desktop-remote/agent start -- \
  agent connect --server https://remote.example.com
```

The Agent prints a verification URL and a short code. Sign into the Dashboard, approve the pending pairing, and optionally give the machine a friendly name. The Agent stores its long-lived device credential in the OS credential store when available, with a user-scoped file fallback.

The workstation does not need a public IP, router port-forward, VPN, SSH exposure or inbound MCP port.

## Connect ChatGPT

ChatGPT's UI and plan availability can change. As of October 2026, OpenAI documents custom MCP apps in Developer Mode on ChatGPT web. Full MCP write/modify support is available to Business and Enterprise/Edu, while Pro is limited to read/fetch custom MCP use.

Current OpenAI setup flow:

1. Enable Developer Mode for the appropriate workspace/account.
2. Go to Settings or Workspace settings → Apps → Create.
3. Enter `https://remote.example.com/mcp` as the MCP endpoint.
4. Select OAuth authentication.
5. Scan tools and complete the Owner OAuth flow.
6. Create the draft app and enable/select it in a chat.

OpenAI's current instructions:
https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

`search` and `fetch` are not required by Open Desktop Remote. The Server exposes Desktop Commander tools directly plus `list_devices` and `get_device_status`.

## First acceptance test

With one Agent showing READY, ask the MCP client to:

1. list devices;
2. read a harmless test file;
3. rewrite that test file;
4. start an interactive process such as `node -i`;
5. send a follow-up input to the same process session.

When exactly one device is READY, `deviceId` is optional. When multiple devices are READY, specify the target device ID (or instruct the model to select a named device first).

## Add and revoke another device

Run the same Agent command on the second computer and approve its pairing in the Dashboard.

From the Dashboard you can:

- rename a device without changing its immutable device ID;
- revoke one device;
- revoke all devices;
- rotate the Owner passphrase.

Revocation invalidates future Agent authentication. It does not remotely erase files or credentials from that machine.

## Upgrade and backup

Before upgrading:

```bash
docker compose stop
docker run --rm \
  -v openremotedesktop_server_data:/data \
  -v "$PWD":/backup alpine \
  sh -c 'cp /data/server.sqlite /backup/server.sqlite.backup'
```

Then update the repository and rebuild:

```bash
git pull
docker compose up -d --build
```

SQLite migrations run on Server startup. Keep the backup until the upgraded Server and at least one Agent have passed your normal acceptance checks.

## Development and verification

```bash
pnpm install
pnpm governance:check
pnpm test:run
pnpm typecheck
pnpm test:e2e
```

For AI-assisted development, Codex and Claude share [the same project instructions](AGENTS.md). See the [AI task, worktree and acceptance workflow](docs/ai-project-management.zh-CN.md) before implementing an Issue or handing a task to another AI.

Validate production Compose configuration with a test domain:

```bash
ODR_DOMAIN=remote.example.test docker compose config
```

See:

- [Architecture](docs/architecture.md)
- [Relay protocol](docs/protocol.md)
- [Self-hosting](docs/self-hosting.md)
- [Agent guide](docs/agent.md)
- [Security model](docs/security.md)
- [Public repository privacy and infrastructure disclosure rules](docs/repository-security.zh-CN.md)
- [Repository secret hygiene and local Git hooks (Chinese)](docs/repository-security.zh-CN.md)

## License

Apache-2.0.
