import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { installAuthDiagnostics } from './auth-diagnostics.js';

describe('opt-in OAuth diagnostic metadata', () => {
  it('records only route/status/error class without cookies, arguments, query or token content', async () => {
    const app = Fastify();
    const events: unknown[] = [];
    installAuthDiagnostics(app, event => events.push(event));
    app.post('/oauth/register', async (_req, reply) => reply.code(400).send({
      error: 'invalid_client_metadata', error_description: 'secret-response-body',
    }));
    try {
      const r = await app.inject({ method: 'POST', url: '/oauth/register?state=secret-query',
        headers: { authorization: 'Bearer secret-access-token', cookie: 'session=secret-cookie', 'user-agent': 'secret-user-agent' },
        payload: { password: 'secret-password', client_id: 'secret-client-id', redirect_uris: ['https://secret-origin.example'] },
      });
      expect(r.statusCode).toBe(400);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event:'auth.http', route:'/oauth/register', method:'POST', status:400,
        authorizationPresent:true, errorCode:'invalid_client_metadata' });
      const text=JSON.stringify(events);
      expect(text).not.toContain('secret');
      expect(text).not.toContain('redirect_uris');
    } finally {await app.close();}
  });

  it('omits non-auth routes and arbitrary unrecognized error text', async () => {
    const app = Fastify();
    const events: unknown[] = [];
    installAuthDiagnostics(app, event => events.push(event));
    app.get('/healthz', async () => ({ok:true}));
    app.post('/mcp', async (_req, reply) => reply.code(401).send({error:'sensitive-error-value'}));
    try {
      await app.inject({url:'/healthz'});
      expect(events).toHaveLength(0);
      await app.inject({method:'POST',url:'/mcp',payload:{ method:'secret-method', params:{secret:'payload'} }});
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({route:'/mcp',status:401,authorizationPresent:false});
      expect(JSON.stringify(events)).not.toMatch(/sensitive|secret/);
    } finally {await app.close();}
  });
});
