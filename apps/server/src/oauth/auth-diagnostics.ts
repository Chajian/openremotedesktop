import type { FastifyInstance, FastifyRequest } from 'fastify';

const routes = new Set([
  '/mcp', '/oauth/register', '/oauth/authorize', '/oauth/token', '/dashboard/login',
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
]);
const errorCodes = new Set([
  'invalid_client_metadata', 'invalid_redirect_uri', 'invalid_request', 'invalid_client',
  'invalid_grant', 'invalid_scope', 'unsupported_grant_type', 'unauthorized_client',
  'access_denied', 'invalid_token', 'insufficient_scope', 'server_error',
]);
export type AuthDiagnosticEvent = {
  at: string;
  event: 'auth.http';
  route: string;
  method: string;
  status: number;
  authorizationPresent: boolean;
  errorCode?: string;
};

/** Explicit opt-in. Allowlisted metadata only; never URLs, token values or payloads. */
export function installAuthDiagnostics(
  app: FastifyInstance,
  emit: (event: AuthDiagnosticEvent) => void = event => { process.stdout.write(JSON.stringify(event) + '\n'); },
): void {
  const errors = new WeakMap<FastifyRequest, string>();
  app.addHook('onSend', async (request, _reply, payload) => {
    if (routes.has(request.routeOptions.url ?? '') && typeof payload === 'string' && payload.length <= 4096) {
      try {
        const code: unknown = JSON.parse(payload)?.error;
        if (typeof code === 'string' && errorCodes.has(code)) errors.set(request, code);
      } catch { /* Non-JSON responses contain nothing useful for this diagnostic. */ }
    }
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route || !routes.has(route)) return;
    const code = errors.get(request);
    emit({ at: new Date().toISOString(), event: 'auth.http', route, method: request.method,
      status: reply.statusCode, authorizationPresent: Boolean(request.headers.authorization),
      ...(code ? { errorCode: code } : {}),
    });
  });
}
