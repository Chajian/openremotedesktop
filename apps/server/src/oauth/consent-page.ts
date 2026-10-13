import { escapeHtml } from "../dashboard/templates.js";

export function renderConsentPage(input: {
  returnTo: string; csrf: string; clientId: string; redirectUri: string; scope: string;
}): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Open Desktop Remote - Authorize</title>
<style>body{font-family:system-ui;max-width:760px;margin:3rem auto;padding:1rem}code{overflow-wrap:anywhere}button{margin:1rem;padding:.7rem}</style>
</head><body><h1>连接 Open Desktop Remote</h1>
<p>此客户端请求通过你的设备读取和修改文件、运行终端命令。只批准你刚刚主动添加且信任的客户端。</p>
<p>Client ID: <code>${escapeHtml(input.clientId)}</code></p>
<p>Callback: <code>${escapeHtml(input.redirectUri)}</code></p>
<p>Scopes: <code>${escapeHtml(input.scope)}</code></p>
<p>授权后客户端可以调用已配对设备上的工具；这不是只读权限。不要批准不认识的回调地址。</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<input type="hidden" name="returnTo" value="${escapeHtml(input.returnTo)}">
<button type="submit" name="decision" value="approve">允许连接 / Allow</button>
<button type="submit" name="decision" value="deny">拒绝 / Deny</button>
</form></body></html>`;
}
