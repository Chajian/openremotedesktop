import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createDatabase } from '../db/database.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
function fixture() {
  const db = createDatabase(':memory:');
  const app = buildApp({ db, config: { databasePath: ':memory:', publicBaseUrl: new URL('https://remote.example.com'), environment: 'test' } });
  cleanups.push(async () => { await app.close(); db.close(); });
  return { db, app };
}
const publicClient = {
  redirect_uris: ['https://chatgpt.com/connector_platform/oauth/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'], token_endpoint_auth_method: 'none',
};

describe('OAuth client registration interoperability', () => {
  it('accepts standard optional metadata and discards untrusted unused extensions', async () => {
    const { app, db } = fixture();
    const response = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      ...publicClient, client_name: 'ChatGPT', client_uri: 'https://chatgpt.com',
      logo_uri: 'https://chatgpt.com/logo.png', scope: 'mcp offline_access',
      contacts: ['test@example.com'], 'client_name#en': 'ChatGPT',
      client_id: 'attacker-chosen-id', client_secret: 'not-an-issued-secret',
      unknown_extension: { source: 'must-not-be-persisted' },
    } });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.client_id).not.toBe('attacker-chosen-id');
    expect(body).not.toHaveProperty('client_secret');
    expect(body).not.toHaveProperty('unknown_extension');
    expect(body.redirect_uris).toEqual(publicClient.redirect_uris);
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get()).toEqual({ n: 1 });
  });

  it('accepts an authorization-code-only client without silently granting refresh', async () => {
    const { app } = fixture();
    const response = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      ...publicClient, client_name: 'Code-only client', grant_types: ['authorization_code'],
    } });
    expect(response.statusCode).toBe(201);
    expect(response.json().grant_types).toEqual(['authorization_code']);
  });

  it('defaults an omitted grant list to authorization_code', async () => {
    const { app } = fixture();
    const response = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
      redirect_uris: publicClient.redirect_uris, token_endpoint_auth_method: 'none', client_name: 'Minimal client',
    } });
    expect(response.statusCode).toBe(201);
    expect(response.json().grant_types).toEqual(['authorization_code']);
  });

  it('still rejects unsupported authentication, unsafe redirects, and invalid grants', async () => {
    const { app, db } = fixture();
    for (const override of [
      { token_endpoint_auth_method: 'client_secret_post' }, { response_types: ['token'] },
      { grant_types: ['password'] }, { grant_types: ['refresh_token'] }, { grant_types: [] },
      { grant_types: ['authorization_code', 'authorization_code'] },
      { redirect_uris: ['http://outside.example/callback'] },
      { redirect_uris: ['https://outside.example/callback#fragment'] },
    ]) {
      const r = await app.inject({ method: 'POST', url: '/oauth/register', payload: { ...publicClient, ...override } });
      expect(r.statusCode).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get()).toEqual({ n: 0 });
  });
});

describe('OAuth discovery before any user authorization', () => {
  it('advertises OAuth without calling a missing credential an invalid token', async () => {
    const { app } = fixture();
    const response = await app.inject({ method: 'POST', url: '/mcp', payload: {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    } });
    expect(response.statusCode).toBe(401);
    const challenge = String(response.headers['www-authenticate']);
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain('resource_metadata="https://remote.example.com/.well-known/oauth-protected-resource/mcp"');
    expect(challenge).not.toContain('error=');
    expect(response.body).not.toContain('invalid_token');
    expect(response.body).not.toContain('tools');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('offers the same canonical MCP resource at both discovery locations', async () => {
    const { app } = fixture();
    const root = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    const path = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(root.statusCode).toBe(200);
    expect(path.statusCode).toBe(200);
    expect(root.json()).toEqual(path.json());
    expect(root.json().resource).toBe('https://remote.example.com/mcp');
  });

  it('continues rejecting invalid credentials and all anonymous execution', async () => {
    const { app } = fixture();
    for (const name of ['initialize', 'tools/list', 'tools/call']) {
      const r = await app.inject({ method: 'POST', url: '/mcp', payload: {
        jsonrpc: '2.0', id: 1, method: name, params: {},
      } });
      expect(r.statusCode).toBe(401);
    }
    const invalid = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer fake-test-token' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
    expect(invalid.statusCode).toBe(401);
    expect(String(invalid.headers['www-authenticate'])).toContain('invalid_token');
  });
});
