# Self-hosting

This guide is for a single-owner V1 deployment.

## 1. Prepare DNS and host

Create a DNS record such as:

```text
remote.example.com -> your VPS public IP
```

Allow inbound TCP 80 and 443. Workstations running the Agent do not need inbound ports.

Install Docker Engine and Docker Compose on the Server host.

## 2. Clone and configure

```bash
git clone https://github.com/Chajian/openremotedesktop.git
cd openremotedesktop
cp .env.example .env
```

Set:

```dotenv
ODR_DOMAIN=remote.example.com
DEBUG_PAYLOAD_LOGGING=false
```

Keep debug payload logging disabled for normal operation.

## 3. Start the Server

```bash
docker compose up -d --build
docker compose ps
docker compose logs server --tail=100
```

Expected endpoints:

- `https://remote.example.com/healthz`
- `https://remote.example.com/readyz`
- `https://remote.example.com/.well-known/oauth-authorization-server`
- `https://remote.example.com/.well-known/oauth-protected-resource/mcp`
- `https://remote.example.com/mcp`
- `https://remote.example.com/dashboard/login`

## 4. Bootstrap the Owner

V1 has exactly one Owner.

```bash
curl -X POST https://remote.example.com/api/bootstrap \
  -H "content-type: application/json" \
  --data '{"password":"a-long-unique-owner-passphrase"}'
```

Bootstrap is accepted only while the Owner table is empty. It is not a registration system.

Sign into `/dashboard/login` after initialization.

## 5. Start an Agent

On the target computer:

```bash
git clone https://github.com/Chajian/openremotedesktop.git
cd openremotedesktop
corepack enable
pnpm --filter @open-desktop-remote/agent... install --frozen-lockfile
pnpm --filter @open-desktop-remote/agent start -- \
  agent connect --server https://remote.example.com
```

First run prints a verification URL and user code. In the Dashboard, approve the pending code and set a device name.

Credentials are reused on later starts; a normal reconnect does not require pairing again.

## 6. Verify READY

The Dashboard should progress from connected/executor-starting to `READY`.

If it remains offline:

- check that the Agent can reach the domain over HTTPS/WSS;
- verify the device was approved and not revoked;
- check Agent output for credential refresh or Desktop Commander startup errors.

If transport connects but executor fails, the device must not be treated as READY.

## 7. Connect an MCP client

Use:

```text
https://remote.example.com/mcp
```

The Server publishes OAuth and protected-resource metadata and supports DCR, Authorization Code + PKCE S256, `mcp` and `offline_access` scopes, refresh-token rotation and opaque bearer tokens.

For current ChatGPT Developer Mode steps, see:
https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt

## 8. Verify file/process behavior

Create a disposable file on the Agent machine and use the MCP client to:

- `list_devices`;
- `read_file`;
- `write_file`;
- `start_process`;
- `interact_with_process`.

Never use production secrets as your first acceptance test.

## 9. Add a second device

Start the Agent on another computer and approve its new code.

When multiple devices are READY, clients must send `deviceId`. The Server deliberately refuses ambiguous calls instead of picking a machine.

## 10. Revoke

Use the Dashboard to revoke one device or all devices.

A revoked device's refresh credential and relay access tokens no longer authorize new connections. To use that computer again, pair it as a new device.

## Backup

The durable state is the SQLite database in the `server_data` volume.

Stop writes before making a simple file backup:

```bash
docker compose stop server
docker run --rm \
  -v openremotedesktop_server_data:/data \
  -v "$PWD":/backup alpine \
  sh -c 'cp /data/server.sqlite /backup/server.sqlite.backup'
docker compose start server
```

Also back up your Compose/.env configuration separately. Do not publish the database backup.

## Upgrade

```bash
git pull
docker compose up -d --build
```

Migrations are transactional. Keep a pre-upgrade database backup until normal acceptance checks pass.

Agents are not automatically updated in V1. Update their working copy/dependencies deliberately.

## Local development without TLS

For development only. The Server uses the native `better-sqlite3` package; on Windows, a source install can require Visual Studio's C++ build workload. The production Docker build compiles it inside Linux instead.

```bash
pnpm install
ODR_PUBLIC_BASE_URL=http://127.0.0.1:3000 \
ODR_DATABASE_PATH=./data/dev.sqlite \
NODE_ENV=development \
pnpm --filter @open-desktop-remote/server start
```

On PowerShell, set the equivalent environment variables with `$env:NAME='value'` before the command.

Production rejects a non-HTTPS public base URL.
