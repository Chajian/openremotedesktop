import type { Device } from "../../devices/device-repository.js";
import { html, type SafeHtml } from "../ui/html.js";
import { appDocument, pageHead, emptyState, callout, type ShellContext } from "../ui/components.js";
import { icon, type IconName } from "../ui/icons.js";
import { t, formatRelative, formatDate } from "../ui/i18n.js";
import { deviceTone, statusKeys } from "../ui/status.js";

export type LiveDevice = Device & { state: string; isSupport?: boolean };
export type DeviceFilter = "all" | "online" | "attention" | "revoked";
export function platformInfo(ctx: ShellContext, platform: string | null): { label: string; tile: string; icon: IconName } {
  if (platform === "win32") return { label: "Windows", tile: "win", icon: "windows" };
  if (platform === "darwin") return { label: "macOS", tile: "mac", icon: "apple" };
  if (platform === "linux") return { label: "Linux", tile: "linux", icon: "linux" };
  return { label: t(ctx.locale, "device.osUnknown"), tile: "unknown", icon: "monitor" };
}
export function osTile(ctx: ShellContext, platform: string | null, extra = ""): SafeHtml {
  const os = platformInfo(ctx, platform);
  return html`<span class="os ${os.tile} ${extra}" title="${os.label}">${icon(os.icon, extra.includes("xl") ? 30 : extra.includes("sm") ? 17 : 22)}</span>`;
}
export function statusChip(ctx: ShellContext, state: string): SafeHtml {
  const tone = deviceTone(state);
  return html`<span class="chip ${tone}"><span class="dot ${tone}" aria-hidden="true"></span>${t(ctx.locale, statusKeys(state).label)}</span>`;
}
export function copyButton(ctx: ShellContext, text: string, label: string, small = true): SafeHtml {
  return html`<button type="button" class="btn btn-secondary ${small ? "btn-sm" : ""}" data-copy="${text}" data-copied-label="${t(ctx.locale, "common.copied")}" aria-label="${label}">${icon("copy", 15)}<span data-copy-label>${label}</span></button>`;
}
export function deviceActions(ctx: ShellContext, device: LiveDevice): SafeHtml {
  const base = `/dashboard/devices/${encodeURIComponent(device.id)}`;
  return html`<details class="dcard-menu"><summary class="btn btn-ghost btn-sm btn-icon" aria-label="${t(ctx.locale, "device.actions")}">${icon("more", 16)}</summary><div class="dcard-menu-pop"><a href="${base}">${t(ctx.locale, "device.rename")}</a>${device.revokedAt === null ? html`<a href="${base}/revoke">${t(ctx.locale, "device.revoke")}</a>` : null}<a class="danger" href="${base}/delete">${t(ctx.locale, "device.delete")}</a></div></details>`;
}

export function deviceCard(ctx: ShellContext, device: LiveDevice, now: number): SafeHtml {
  const tone = deviceTone(device.state), keys = statusKeys(device.state);
  const when = device.state === "READY" ? t(ctx.locale, keys.label) : device.revokedAt !== null ? t(ctx.locale, "device.revokedAt", { time: formatDate(ctx.locale, device.revokedAt) }) : t(ctx.locale, "device.lastSeen", { time: formatRelative(ctx.locale, device.lastSeenAt, now) });
  return html`<article class="dcard ${tone === "err" ? "err" : ""} ${device.state === "REVOKED" ? "revoked" : ""}" data-device-id="${device.id}" data-state="${device.state}"><div class="dcard-top">${osTile(ctx, device.platform, device.state === "REVOKED" ? "dim" : "")}${statusChip(ctx, device.state)}${deviceActions(ctx, device)}</div><div class="dcard-body"><h3 class="dcard-name" style="margin:0;overflow-wrap:anywhere"><a href="${`/dashboard/devices/${encodeURIComponent(device.id)}`}">${device.name}</a></h3><div class="dcard-meta"><span>${platformInfo(ctx, device.platform).label}</span>${device.isSupport ? html`<span class="chip busy">${t(ctx.locale,"support.temporary")}</span>` : null}<span>·</span><span>${when}</span></div>${tone === "err" ? html`<div class="dcard-fix err">${t(ctx.locale, keys.desc)}</div>` : tone === "off" ? html`<div class="dcard-fix off">${t(ctx.locale, "device.cardOffline")}</div>` : tone === "ok" ? html`<div class="dcard-fix ok">${icon("zap", 14)}${t(ctx.locale, "device.ready")}</div>` : null}</div><div class="dcard-foot"><span>${t(ctx.locale, "device.id")}</span><span class="mono">${device.id.slice(0, 8)}</span><div class="right"><button type="button" class="btn btn-ghost btn-sm btn-icon" data-copy="${device.id}" data-copied-label="${t(ctx.locale, "common.copied")}" aria-label="${t(ctx.locale, "device.copyId")}">${icon("copy", 15)}</button></div></div></article>`;
}
export function addCard(ctx: ShellContext): SafeHtml {
  return html`<a class="dcard add" href="/dashboard/connect"><span class="plus">${icon("plus", 20)}</span><span>${t(ctx.locale, "nav.addComputer")}</span></a>`;
}
export function renderDevices(ctx: ShellContext, input: { devices: LiveDevice[]; filter: DeviceFilter; now: number; deleted?: boolean }): string {
  const count = input.devices.filter(d => d.state !== "REVOKED").length;
  const counts = { all: count, online: input.devices.filter(d => d.state === "READY").length, attention: input.devices.filter(d => deviceTone(d.state) === "err").length, revoked: input.devices.filter(d => d.state === "REVOKED").length };
  const list = input.devices.filter(d => input.filter === "all" ? d.state !== "REVOKED" : input.filter === "online" ? d.state === "READY" : input.filter === "attention" ? deviceTone(d.state) === "err" : d.state === "REVOKED");
  const filters = [["all", "devices.all"], ["online", "status.READY.label"], ["attention", "status.EXECUTOR_FAILED.label"], ["revoked", "status.REVOKED.label"]] as const;
  const body = html`${pageHead({ title: t(ctx.locale, "nav.devices"), lead: input.devices.length ? t(ctx.locale, "devices.lead", { count, ready: counts.online }) : t(ctx.locale, "devices.empty.lead") })}${input.deleted ? callout("ok", null, t(ctx.locale, "device.deletedSuccess")) : null}${input.devices.length ? html`<form class="seg-tabs" method="get" action="/dashboard/devices" style="flex-wrap:wrap">${filters.map(([filter, key]) => html`<button class="${filter === input.filter ? "on" : ""}" type="submit" name="status" value="${filter}" aria-pressed="${filter === input.filter ? "true" : "false"}">${t(ctx.locale, key)}<span class="n">${counts[filter]}</span></button>`)}</form><div class="dgrid">${list.map(d => deviceCard(ctx, d, input.now))}${input.filter === "all" ? addCard(ctx) : null}</div>${!list.length ? html`<p class="muted" style="text-align:center;padding:40px 0">${t(ctx.locale, "devices.noMatch")}</p>` : null}` : emptyState({ icon: "monitor", title: t(ctx.locale, "devices.empty.title"), body: t(ctx.locale, "devices.empty.body"), action: html`<a class="btn btn-primary btn-lg" href="/dashboard/connect">${icon("plus", 17)}${t(ctx.locale, "nav.addComputer")}</a>` })}`;
  return appDocument({ ctx, title: t(ctx.locale, "nav.devices"), body, fab: true });
}
