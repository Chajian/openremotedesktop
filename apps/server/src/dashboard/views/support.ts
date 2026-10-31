import type { SupportSession } from "../../support/support-service.js";
import { html, type SafeHtml } from "../ui/html.js";
import { appDocument, pageHead, hiddenInput, soloDocument, type ShellContext } from "../ui/components.js";
import { icon } from "../ui/icons.js";
import { t, type Locale, formatDateTime } from "../ui/i18n.js";
import type { DownloadSource } from "../installer.js";

export function renderSupportDashboard(
  ctx: ShellContext, sessions: SupportSession[],
  devices: ReadonlyMap<string, string>, enabled: boolean,
): string {
  const form = html`<section class="card card-pad" style="margin-bottom:24px">
    <h2>${t(ctx.locale, "support.createTitle")}</h2>
    <p class="muted">${t(ctx.locale, "support.createLead")}</p>
    <form method="post" action="/dashboard/support/create" style="margin-top:16px">
      ${hiddenInput("csrf", ctx.csrf)}
      <div class="field"><label for="support-label">${t(ctx.locale, "support.name")}</label>
        <input class="input" name="label" id="support-label" maxlength="80"
         placeholder="${t(ctx.locale, "support.namePlaceholder")}" required></div>
      <button class="btn btn-primary" type="submit" style="margin-top:12px">${t(ctx.locale, "support.create")}</button>
    </form>
  </section>`;
  const cards = sessions.map(s => html`<article class="card card-pad" style="margin:12px 0">
      <div class="row" style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <h3>${s.label}</h3><span class="chip">${t(ctx.locale, `support.state.${s.state}`)}</span>
      </div>
      <p class="muted">${t(ctx.locale, "support.createdAt")}: ${formatDateTime(ctx.locale,s.createdAt)}</p>
      ${s.deviceId ? (s.state === "active" && s.deviceAccessible
        ? html`<a href="/dashboard/devices/${encodeURIComponent(s.deviceId)}">${t(ctx.locale,"support.device")}: ${s.deviceId.slice(0,8)} (${devices.get(s.deviceId) ?? "OFFLINE"})</a>`
        : html`<span class="muted">${t(ctx.locale,"support.device")}: ${s.deviceId.slice(0,8)} (${t(ctx.locale,"support.deviceRemoved")})</span>`)
        : null}
      ${s.state !== "ended" ? html`<a class="btn btn-danger btn-sm" style="margin-top:14px"
        href="/dashboard/support/${encodeURIComponent(s.id)}/end">${t(ctx.locale,"support.end")}</a>` : null}
    </article>`);
  const body = html`${pageHead({title:t(ctx.locale,"support.title"),lead:t(ctx.locale,"support.lead")})}
    ${enabled ? form : null}<h2>${t(ctx.locale,"support.history")}</h2>
    ${cards.length ? cards : html`<p class="muted">${t(ctx.locale,"support.empty")}</p>`}`;
  return appDocument({ctx,title:t(ctx.locale,"support.title"),body});
}

export function renderSupportCreated(ctx: ShellContext, invite: string, session: SupportSession): string {
  const url = new URL("/support/invite/" + invite, ctx.publicBaseUrl).toString();
  const body = html`${pageHead({title:t(ctx.locale,"support.created"),lead:session.label})}
    <section class="card card-pad" style="max-width:760px">
      <p>${t(ctx.locale,"support.inviteHint")}</p>
      <div class="code"><div class="code-body" style="overflow-wrap:anywhere">${url}</div></div>
      <button class="btn btn-primary" data-copy="${url}" data-copied-label="${t(ctx.locale,"common.copied")}" type="button">
        ${icon("copy",15)}<span data-copy-label>${t(ctx.locale,"support.copyLink")}</span>
      </button>
      <p class="muted" style="margin-top:16px">${t(ctx.locale,"support.inviteExpiry")}: ${formatDateTime(ctx.locale,session.inviteExpiresAt)}</p>
      <p class="muted">${t(ctx.locale,"support.noTimeout")}</p>
      <a class="btn btn-secondary" href="/dashboard/support">${t(ctx.locale,"support.back")}</a>
    </section>`;
  return appDocument({ctx,title:t(ctx.locale,"support.created"),body});
}

export function renderCustomerSupport(locale: Locale, baseUrl: URL, invite: string,
  label: string, expiresAt: number, installCommand?: string, downloadSource: DownloadSource = "official"): string {
  const command = installCommand ??
    `pnpm --filter @open-desktop-remote/agent start -- agent support --server ${baseUrl.origin} --invite ${invite}`;
  const body: SafeHtml = html`<section class="solo-card card">
    <h1 class="h1">${t(locale,"support.customerTitle")}</h1>
    <p class="lead">${t(locale,"support.customerLead", {label})}</p>
    <p>${t(locale,"support.customerFullAccess")}</p>
    <p class="muted">${t(locale,"support.inviteExpiry")}: ${formatDateTime(locale,expiresAt)}</p>
    <p class="muted">${t(locale,installCommand ? "support.installerReady" : "support.devOnly")}</p>
    ${installCommand ? html`<div class="field"><p>${t(locale,"installer.downloadSource")}</p>
      <a class="btn ${downloadSource === "official" ? "btn-primary" : "btn-secondary"}" href="?downloadSource=official">${t(locale,"installer.official")}</a>
      <a class="btn ${downloadSource === "npmmirror" ? "btn-primary" : "btn-secondary"}" href="?downloadSource=npmmirror">${t(locale,"installer.npmmirror")}</a>
      <p class="muted">${t(locale,"installer.sourceHint")}</p></div>` : null}
    <div class="code"><div class="code-bar">PowerShell</div>
      <div class="code-body" style="overflow-wrap:anywhere">${command}</div></div>
    <button class="btn btn-secondary" type="button" data-copy="${command}" data-copied-label="${t(locale,"common.copied")}">
      ${icon("copy",15)}<span data-copy-label>${t(locale,"support.copyCommand")}</span></button>
    <p class="muted">${t(locale,"support.customerConsent")}</p>
  </section>`;
  return soloDocument({locale,title:t(locale,"support.customerTitle"),body,enhance:true});
}
