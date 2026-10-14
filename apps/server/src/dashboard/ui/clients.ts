export type ClientIdentity = { name: string | null; host: string; kind: "known" | "local" | "other" };
/** Display-only. Derived from the exact registered redirect host; client-supplied names are never stored. */
export function clientIdentity(redirectUri: string): ClientIdentity {
  const url = new URL(redirectUri);
  if (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") return { name: "ChatGPT", host: url.host, kind: "known" };
  if (url.hostname === "claude.ai") return { name: "Claude", host: url.host, kind: "known" };
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return { name: null, host: url.host, kind: "local" };
  return { name: null, host: url.host, kind: "other" };
}
