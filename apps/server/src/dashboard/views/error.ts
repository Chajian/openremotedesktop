import { html } from "../ui/html.js";
import { appDocument, soloDocument, type ShellContext } from "../ui/components.js";
import { icon } from "../ui/icons.js";
import { t, type Locale } from "../ui/i18n.js";

export function renderErrorPage(input: { locale: Locale; status: number; kind: "expired" | "invalid" | "notFound" | "forbidden" | "loginExpired"; backHref: string; ctx?: ShellContext | undefined }): string {
  const title = t(input.locale, `error.${input.kind}.title`);
  const backHref = input.kind === "loginExpired" ? "/dashboard/login" : input.backHref;
  const body = html`<section class="solo-card" data-error-kind="${input.kind}" style="text-align:center;max-width:600px;margin:0 auto"><span class="os unknown xl" style="margin:0 auto 20px">${icon(input.kind === "notFound" ? "search" : "alert", 28)}</span><p class="eyebrow" style="justify-content:center">${input.status}</p><h1 class="h1">${title}</h1><p class="lead" style="margin:12px auto 24px">${t(input.locale, `error.${input.kind}.body`)}</p><a class="btn btn-primary" href="${backHref}">${t(input.locale, `error.${input.kind}.action`)}</a></section>`;
  return input.ctx ? appDocument({ ctx: input.ctx, title, body }) : soloDocument({ locale: input.locale, title, body, langSwitchPath: backHref });
}
