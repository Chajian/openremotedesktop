import { html, type SafeHtml } from "../dashboard/ui/html.js";
import { hiddenInput, soloDocument } from "../dashboard/ui/components.js";
import { icon, type IconName } from "../dashboard/ui/icons.js";
import { t, type MessageKey } from "../dashboard/ui/i18n.js";

function bilingual(key: MessageKey, params: Record<string, string | number> = {}): SafeHtml {
  return html`<span lang="zh-CN">${t("zh-CN", key, params)}</span><small lang="en" class="muted" style="display:block;font-size:.82em;font-weight:400;margin-top:4px">${t("en", key, params)}</small>`;
}

export function renderConsentPage(input: {
  returnTo: string; csrf: string; clientId: string; redirectUri: string; scope: string;
}): string {
  const host = new URL(input.redirectUri).host;
  const capabilities: Array<{ id: string; icon: IconName; title: MessageKey; desc: MessageKey }> = [
    { id: "files", icon: "folder", title: "consent.files", desc: "consent.filesDesc" },
    { id: "terminal", icon: "terminal", title: "consent.terminal", desc: "consent.terminalDesc" },
    { id: "devices", icon: "monitor", title: "consent.devices", desc: "consent.devicesDesc" },
  ];
  if (input.scope.split(/\s+/).includes("offline_access")) capabilities.push({ id: "offline_access", icon: "history", title: "consent.offline", desc: "consent.offlineDesc" });
  const body = html`<main class="solo-card" data-view="consent">
    <div class="mini-bridge"><span class="t">${icon("messageText", 24)}</span><span class="l"></span><span class="t hub">${icon("logo", 24)}</span></div>
    <h1 class="h1" style="text-align:center;overflow-wrap:anywhere">${bilingual("consent.title", { host })}</h1>
    <p class="lead" style="text-align:center;font-size:15px">${bilingual("consent.lead")}</p>
    <ul class="scope">${capabilities.map(item => html`<li data-capability="${item.id}"><span class="ic">${icon(item.icon, 18)}</span><div>${bilingual(item.title)}<div class="fine" style="margin-top:6px">${bilingual(item.desc)}</div></div></li>`)}</ul>
    <dl class="detail-box"><dt>${bilingual("consent.callback")}</dt><dd class="hl">${input.redirectUri}</dd><dt>${bilingual("consent.clientId")}</dt><dd>${input.clientId}</dd><dt>${bilingual("consent.scope")}</dt><dd>${input.scope}</dd></dl>
    <div class="callout busy" style="margin-top:16px">${icon("alert", 18)}<p>${bilingual("consent.warning")}</p></div>
    <form method="post" action="/oauth/authorize" class="row" style="margin-top:22px;align-items:stretch;gap:12px">
      ${hiddenInput("csrf", input.csrf)}${hiddenInput("returnTo", input.returnTo)}
      <button type="submit" name="decision" value="deny" class="btn btn-secondary btn-lg" style="flex:1;min-width:0;height:auto;padding:10px;white-space:normal"><span>${bilingual("consent.deny")}</span></button>
      <button type="submit" name="decision" value="approve" class="btn btn-primary btn-lg" style="flex:1.5;min-width:0;height:auto;padding:10px;white-space:normal"><span>${bilingual("consent.approve")}</span></button>
    </form>
  </main>`;
  return soloDocument({ locale: "zh-CN", title: t("zh-CN", "consent.title", { host }), body, footer: bilingual("consent.footer"), langSwitchPath: null, enhance: false });
}
