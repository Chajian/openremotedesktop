import { html } from "../ui/html.js";
import { hiddenInput, soloDocument, type ShellContext } from "../ui/components.js";
import { t } from "../ui/i18n.js";
import type { PairingError, PairingValues } from "../ui/pairing.js";
import { pairingFields } from "./connect.js";

export function renderActivate(ctx: ShellContext, input: { error: PairingError | null; values: PairingValues }): string {
  const body = html`<div class="solo-card"><h1 class="h1">${t(ctx.locale, "activate.title")}</h1><p class="lead" style="font-size:15px">${t(ctx.locale, "activate.lead")}</p><form method="post" action="/dashboard/pairings/approve" style="margin-top:22px">${hiddenInput("csrf", ctx.csrf)}${hiddenInput("origin", "device")}${pairingFields(ctx, input)}<button class="btn btn-primary btn-lg btn-block" type="submit" style="margin-top:20px">${t(ctx.locale, "activate.submit")}</button></form><form method="post" action="/dashboard/logout" style="text-align:center;margin-top:16px">${hiddenInput("csrf", ctx.csrf)}<button class="btn btn-ghost btn-sm" type="submit">${t(ctx.locale, "activate.switch")}</button></form><p class="fine" style="text-align:center;margin:14px 0 0">${t(ctx.locale, "activate.warning")}</p></div>`;
  const footer = html`<span class="mono">${ctx.publicBaseUrl.host}</span><span>·</span><span>${t(ctx.locale, "activate.noCode")}</span><a class="link" href="/dashboard/connect">${t(ctx.locale, "activate.help")}</a>`;
  return soloDocument({ locale: ctx.locale, title: t(ctx.locale, "activate.title"), body, footer, langSwitchPath: "/device", enhance: true });
}
