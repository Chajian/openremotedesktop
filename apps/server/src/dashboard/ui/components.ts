import type { AccountSummary } from "../../auth/owner-repository.js";
import { html, raw, type SafeHtml } from "./html.js";
import { t, type Locale, type MessageKey } from "./i18n.js";
import { icon, type IconName } from "./icons.js";
import { STYLES } from "./styles.js";

export type NavKey = "overview" | "devices" | "chatgpt" | "settings" | "support";
export type ShellContext = { locale: Locale; account: AccountSummary | null; nav: NavKey | null; path: string; csrf: string; publicBaseUrl: URL; supportEnabled?: boolean };

export function hiddenInput(name: string, value: string): SafeHtml {
  return html`<input type="hidden" name="${name}" value="${value}">`;
}
export function accountLabel(locale: Locale, account: AccountSummary | null): string {
  return account?.authSource === "github" && account.githubLogin ? `@${account.githubLogin}` : t(locale, "account.owner");
}
export function langSwitch(locale: Locale, path: string): SafeHtml {
  return html`<span aria-label="${t(locale, "footer.language")}">${(["en", "zh-CN"] as const).map((language, i) => html`${i ? " · " : ""}${language === locale ? html`<span lang="${language}">${language === "en" ? "English" : "中文"}</span>` : html`<a lang="${language}" href="${`/dashboard/lang?to=${language}&returnTo=${encodeURIComponent(path)}`}">${language === "en" ? "English" : "中文"}</a>`}`)}</span>`;
}
function brand(locale: Locale): SafeHtml {
  return html`<a class="brand" href="/dashboard"><span class="logo-tile">${icon("logo", 18)}</span><span>${t(locale, "app.name")}</span></a>`;
}
function document(locale: Locale, title: string, body: SafeHtml, enhance: boolean, refreshSeconds?: number | undefined): string {
  return html`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${title} · ${t(locale, "app.name")}</title><style>${raw(STYLES)}</style>${refreshSeconds ? html`<meta http-equiv="refresh" content="${refreshSeconds}">` : null}</head><body>${body}${enhance ? html`<script src="/dashboard/assets/ui.js" defer></script>` : null}</body></html>`.value;
}
const tabs: ReadonlyArray<{ key: NavKey; href: string; label: MessageKey; mobile: MessageKey; icon: IconName }> = [
  { key: "overview", href: "/dashboard", label: "nav.overview", mobile: "nav.overview", icon: "home" },
  { key: "devices", href: "/dashboard/devices", label: "nav.devices", mobile: "nav.devices", icon: "monitor" },
  { key: "support", href: "/dashboard/support", label: "nav.support", mobile: "nav.support", icon: "shield" },
  { key: "chatgpt", href: "/dashboard/mcp", label: "nav.chatgpt", mobile: "nav.connect", icon: "messageText" },
  { key: "settings", href: "/dashboard/settings", label: "nav.settings", mobile: "nav.me", icon: "user" },
];
export function appDocument(input: { ctx: ShellContext; title: string; body: SafeHtml; refreshSeconds?: number | undefined; fab?: boolean | undefined; enhance?: boolean | undefined }): string {
  const { ctx } = input;
  const tab = (mobile: boolean) => tabs.filter(item => item.key !== "support" || ctx.supportEnabled).map(item => html`<a class="${ctx.nav === item.key ? "on" : ""}" href="${item.href}"${ctx.nav === item.key ? html` aria-current="page"` : null}>${mobile ? icon(item.icon, 21) : null}<span>${t(ctx.locale, mobile ? item.mobile : item.label)}</span></a>`);
  const content = html`<header class="nav"><div class="nav-in">${brand(ctx.locale)}<nav class="tabs" aria-label="${t(ctx.locale, "nav.primary")}">${tab(false)}</nav><div class="nav-right"><a class="btn btn-primary btn-sm" href="/dashboard/connect">${icon("plus", 15)}${t(ctx.locale, "nav.addComputer")}</a><a class="avatar" href="/dashboard/settings" title="${accountLabel(ctx.locale, ctx.account)}" aria-label="${accountLabel(ctx.locale, ctx.account)}">${ctx.account?.authSource === "github" ? (ctx.account.githubLogin?.[0] ?? "O") : "O"}</a></div></div></header><main class="wrap">${input.body}</main><footer class="lang-switch" style="padding-bottom:72px">${langSwitch(ctx.locale, ctx.path)}<span aria-hidden="true">·</span><form method="post" action="/dashboard/logout">${hiddenInput("csrf", ctx.csrf)}<button type="submit">${t(ctx.locale, "nav.signOut")}</button></form></footer>${input.fab ? html`<a class="btn btn-primary mfab" href="/dashboard/connect">${icon("plus", 17)}${t(ctx.locale, "nav.addComputer")}</a>` : null}<nav class="${ctx.supportEnabled ? "mtab has-support" : "mtab"}" aria-label="${t(ctx.locale, "nav.mobile")}">${tab(true)}</nav>`;
  return document(ctx.locale, input.title, content, input.enhance ?? true, input.refreshSeconds);
}
export function soloDocument(input: { locale: Locale; title: string; body: SafeHtml; footer?: SafeHtml | undefined; langSwitchPath?: string | null | undefined; enhance?: boolean | undefined }): string {
  const content = html`<div class="solo"><div class="solo-wrap"><div class="solo-brand">${brand(input.locale)}</div>${input.body}<footer class="solo-foot">${input.footer}${input.langSwitchPath != null ? langSwitch(input.locale, input.langSwitchPath) : null}</footer></div></div>`;
  return document(input.locale, input.title, content, input.enhance ?? false);
}
export function pageHead(input: { eyebrow?: string | undefined; title: string; lead?: string | undefined; actions?: SafeHtml | undefined }): SafeHtml {
  return html`<div class="page-head"><div>${input.eyebrow ? html`<p class="eyebrow">${input.eyebrow}</p>` : null}<h1 class="h1">${input.title}</h1>${input.lead ? html`<p class="lead">${input.lead}</p>` : null}</div>${input.actions ? html`<div class="actions">${input.actions}</div>` : null}</div>`;
}
export function callout(tone: "ok" | "busy" | "err" | "accent" | "plain", title: string | null, body: SafeHtml | string): SafeHtml {
  return html`<div class="callout ${tone}"${tone === "err" ? html` role="alert"` : null}>${icon(tone === "err" || tone === "busy" ? "alert" : tone === "ok" ? "circleCheck" : "info", 18)}<div>${title ? html`<b>${title}</b>` : null}${typeof body === "string" ? html`<p>${body}</p>` : body}</div></div>`;
}
export function codeBlock(input: { locale: Locale; label: string; prompt: string; lines: string[]; copyText?: string | undefined }): SafeHtml {
  return html`<div class="code"><div class="code-bar">${icon("terminal", 15)}<span>${input.label}</span>${input.copyText !== undefined ? html`<button class="btn btn-sm" type="button" data-copy="${input.copyText}" data-copied-label="${t(input.locale, "common.copied")}">${icon("copy", 14)}<span data-copy-label>${t(input.locale, "common.copy")}</span></button>` : null}</div><div class="code-body">${input.lines.map(line => line.startsWith("#") ? html`<div class="code-line"><span class="c">${line}</span></div>` : html`<div class="code-line"><span class="p">${input.prompt}</span><span>${line}</span></div>`)}</div></div>`;
}
export function emptyState(input: { icon: IconName; title: string; body: string; action?: SafeHtml | undefined }): SafeHtml {
  return html`<section class="card card-pad" style="text-align:center;padding:64px 24px"><span class="os win xl" style="margin:0 auto 16px">${icon(input.icon, 28)}</span><h3 style="font-size:20px">${input.title}</h3><p class="muted" style="max-width:420px;margin:8px auto 22px">${input.body}</p>${input.action}</section>`;
}
