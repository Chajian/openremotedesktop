import type { FastifyReply, FastifyRequest } from "fastify";

/** Only internal landing pages; never accept a URL supplied by a client as a redirect. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\\\r\n\0]/.test(value)) return "/dashboard";
  const path = value.split("?")[0]!;
  if (!["/oauth/authorize", "/dashboard", "/dashboard/mcp", "/device"].includes(path) || value.includes("#")) return "/dashboard";
  return value;
}

export function loginNonce(request: FastifyRequest): string | null {
  const raw = request.headers.cookie?.split(";").map(x => x.trim())
    .find(x => x.startsWith("odr_login_nonce="))?.slice("odr_login_nonce=".length);
  return raw && /^[A-Za-z0-9_-]{32}$/.test(raw) ? raw : null;
}

export function privateBrowserPage(reply: FastifyReply, callbackOrigin?: string): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callbackOrigin ? " " + callbackOrigin : ""}; frame-ancestors 'none'; base-uri 'none'`);
}
