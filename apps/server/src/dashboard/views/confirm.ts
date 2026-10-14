import { html } from "../ui/html.js";
import { appDocument, hiddenInput, type ShellContext } from "../ui/components.js";
import { icon } from "../ui/icons.js";
import { t } from "../ui/i18n.js";

export function renderConfirm(ctx: ShellContext, input: { title: string; bullets: string[]; action: string; submitLabel: string; cancelHref: string; danger: boolean; confirmPhrase?: string | undefined }): string {
  const body = html`<section class="card" style="max-width:520px;margin:24px auto;border-radius:22px"><div class="dialog-body"><span class="danger-mark">${icon("alert", 20)}</span><h1 class="h1" style="font-size:24px;margin:16px 0">${input.title}</h1><ul style="padding-left:20px;color:var(--text-2);line-height:1.8">${input.bullets.map(bullet => html`<li>${bullet}</li>`)}</ul></div><form method="post" action="${input.action}">${hiddenInput("csrf", ctx.csrf)}${input.confirmPhrase ? html`<div class="field" style="padding:0 28px 16px"><label for="confirm-text">${t(ctx.locale, "settings.revokeAll.type", { phrase: input.confirmPhrase })}</label><input name="confirmText" data-confirm-match="${input.confirmPhrase}" id="confirm-text" class="input" autocomplete="off" placeholder="${input.confirmPhrase}"></div>` : null}<div class="dialog-foot" style="flex-wrap:wrap"><a class="btn btn-secondary" href="${input.cancelHref}">${t(ctx.locale, "common.cancel")}</a><button class="btn ${input.danger ? "btn-danger-solid" : "btn-primary"}" type="submit">${input.submitLabel}</button></div></form></section>`;
  return appDocument({ ctx, title: input.title, body });
}
