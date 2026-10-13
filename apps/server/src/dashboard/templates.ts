import type { Device } from "../devices/device-repository.js";
import type { AuthorizedOAuthClient } from "../oauth/client-repository.js";

export type DashboardDevice = Device & { state: string };

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.5rem;text-align:left}
form{display:inline-block;margin:.2rem}.stack{display:block;margin:.8rem 0}
code{background:#f4f4f4;padding:.2rem .35rem}nav a{margin-right:1rem}
</style></head><body><nav><a href="/dashboard">Devices</a><a href="/dashboard/mcp">MCP setup</a></nav>
<h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function hiddenCsrf(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

export function renderLoginPage(returnTo = "/dashboard", csrf = "", error = "", githubEnabled = false): string {
  return page(
    "Open Desktop Remote",
    `<p>${escapeHtml(error)}</p><form class="stack" method="post" action="/dashboard/login">
${hiddenCsrf(csrf)}<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
<label>Owner passphrase <input type="password" name="password" required></label>
<button type="submit">Sign in</button></form>
${githubEnabled ? '<p><a href="/auth/github?returnTo=' + encodeURIComponent(returnTo) + '">Sign in with GitHub</a></p>' : ""}`,
  );
}

export function renderDashboard(input: {
  devices: DashboardDevice[];
  approvedClients: AuthorizedOAuthClient[];
  csrf: string;
  canChangePassword: boolean;
}): string {
  const deviceRows = input.devices
    .map(
      (device) => `<tr><td>${escapeHtml(device.name)}</td>
<td><code>${escapeHtml(device.id.slice(0, 8))}</code></td>
<td>${escapeHtml(device.state)}</td><td>${escapeHtml(device.platform ?? "-")}</td>
<td>${escapeHtml(device.agentVersion ?? "-")}</td>
<td>${escapeHtml(device.desktopCommanderVersion ?? "-")}</td>
<td>${escapeHtml(device.lastSeenAt ?? "-")}</td>
<td><form method="post" action="/dashboard/devices/${escapeHtml(device.id)}/rename">
${hiddenCsrf(input.csrf)}<input name="name" value="${escapeHtml(device.name)}" required>
<button>Rename</button></form>
<form method="post" action="/dashboard/devices/${escapeHtml(device.id)}/revoke">
${hiddenCsrf(input.csrf)}<button>Revoke</button></form></td></tr>`,
    )
    .join("");

  const approvedClientRows = input.approvedClients.map((client) =>
    `<tr><td><code>${escapeHtml(client.clientId)}</code></td>
<td>${client.redirectUris.map((uri) => `<code>${escapeHtml(uri)}</code>`).join(" ")}</td>
<td>${escapeHtml(new Date(client.authorizedAt).toISOString())}</td>
<td><form method="post" action="/dashboard/clients/${encodeURIComponent(client.clientId)}/revoke">
${hiddenCsrf(input.csrf)}<button>Revoke access</button></form></td></tr>`,
  ).join("");

  const ownerPasswordControls = input.canChangePassword ? [
    '<h2>Owner passphrase</h2>',
    '<form class="stack" method="post" action="/dashboard/password">',
    hiddenCsrf(input.csrf),
    '<input type="password" name="currentPassword" placeholder="Current passphrase" required>',
    '<input type="password" name="newPassword" placeholder="New passphrase" minlength="12" required>',
    '<button>Change passphrase</button></form>',
  ].join("\n") : "";

  return page(
    "Device administration",
    `<h2>Devices</h2><table><thead><tr><th>Name</th><th>ID</th><th>State</th><th>OS</th><th>Agent</th><th>Desktop Commander</th><th>Last seen</th><th>Actions</th></tr></thead>
<tbody>${deviceRows || '<tr><td colspan="8">No devices</td></tr>'}</tbody></table>
<h2>Pair a computer</h2>
<p>Start the Agent on your computer, then enter the verification code displayed there. Pending pairing codes are never listed publicly.</p>
<form class="stack" method="post" action="/dashboard/pairings/approve">
${hiddenCsrf(input.csrf)}
<input name="userCode" placeholder="XXXX-XXXX" pattern="[A-Z2-9]{4}-[A-Z2-9]{4}" required>
<input name="friendlyName" placeholder="Device name">
<button>Approve pairing</button></form>
<h2>Authorized MCP clients</h2>
<p>Only explicitly approved clients receive access tokens. Revoking access invalidates all existing tokens for that client.</p>
<table><thead><tr><th>Client ID</th><th>Redirect URI</th><th>Approved</th><th>Action</th></tr></thead>
<tbody>${approvedClientRows || '<tr><td colspan="4">No authorized clients</td></tr>'}</tbody></table>
<form class="stack" method="post" action="/dashboard/logout">
${hiddenCsrf(input.csrf)}<button>Sign out</button></form>
${ownerPasswordControls}
<form class="stack" method="post" action="/dashboard/devices/revoke-all">
${hiddenCsrf(input.csrf)}<button>Revoke all devices</button></form>
<p>Server version: 0.1.0</p>`,
  );
}

export function renderMcpPage(mcpUrl: string): string {
  return page(
    "MCP connection",
    `<p>Remote MCP endpoint: <code>${escapeHtml(mcpUrl)}</code></p>
<p>Authentication: OAuth 2.0 Authorization Code with PKCE. Compatible clients should discover authorization metadata automatically.</p>`,
  );
}
