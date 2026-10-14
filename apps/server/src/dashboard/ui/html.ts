export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string { return this.value; }
}
export type Html = SafeHtml | string | number | boolean | null | undefined | readonly Html[];

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
export function raw(value: string): SafeHtml { return new SafeHtml(value); }

function toHtml(value: Html): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return (value as readonly Html[]).map(toHtml).join("");
  if (value === null || value === undefined || typeof value === "boolean") return "";
  return escapeHtml(value);
}
export function html(strings: TemplateStringsArray, ...values: Html[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((value, index) => { out += toHtml(value) + (strings[index + 1] ?? ""); });
  return new SafeHtml(out);
}
