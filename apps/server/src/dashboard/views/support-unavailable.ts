import { soloDocument } from "../ui/components.js";
import { html } from "../ui/html.js";
import { t, type Locale } from "../ui/i18n.js";

export type SupportUnavailableReason = "invalid" | "used" | "expired";

export function renderSupportUnavailable({ locale, reason }: {
  locale: Locale;
  reason: SupportUnavailableReason;
}): string {
  const title = t(locale, `support.unavailable.${reason}.title`);
  const body = html`<section class="solo-card card">
    <h1 class="h1">${title}</h1>
    <p class="lead">${t(locale, `support.unavailable.${reason}.reason`)}</p>
    <p>${t(locale, `support.unavailable.${reason}.next`)}</p>
  </section>`;
  return soloDocument({ locale, title, body });
}
