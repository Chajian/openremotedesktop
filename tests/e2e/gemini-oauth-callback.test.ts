import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { connectMcpClient, startTestServer, waitFor } from "./helpers/test-server.js";
import { startRealAgent } from "./helpers/test-agent.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function field(html: string, name: string) {
  const raw = new RegExp('name="' + name + '" value="([^"]*)"').exec(html)?.[1];
  if (raw === undefined) throw new Error("Missing consent field " + name);
  return raw.replaceAll("&quot;", '"').replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

it("exchanges a simulated Gemini callback code and accesses a real isolated test Agent via MCP", async () => {
  const server = await startTestServer({ geminiCallbackCompatEnabled: true });
  cleanups.push(() => server.close());
  const cookie = await server.bootstrapAndLogin(randomBytes(32).toString("base64url"));
  const callback = "https://oauth-redirect.googleusercontent.com/r/fixture";
  const verifier = randomBytes(48).toString("base64url");
  const state = 'fixture & " Unicode \u96ea';
  const resource = new URL("/mcp", server.baseUrl).toString();
  const registration = await server.app.inject({
    method: "POST", url: "/oauth/register",
    payload: { redirect_uris: [callback], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none" },
  });
  expect(registration.statusCode).toBe(201);
  const clientId = registration.json().client_id as string;
  const request = new URLSearchParams({ response_type: "code", client_id: clientId,
    redirect_uri: callback, scope: "mcp", state, resource, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  const page = await server.app.inject({ method: "GET", url: "/oauth/authorize?" + request, headers: { cookie } });
  expect(page.statusCode).toBe(200);
  const consent = await server.app.inject({ method: "POST", url: "/oauth/authorize", headers: { cookie },
    payload: { returnTo: field(page.body, "returnTo"), csrf: field(page.body, "csrf"), decision: "approve" } });
  expect(consent.statusCode).toBe(200);
  expect(consent.headers.location).toBeUndefined();
  const href = /<a href="([^"]*)" rel="noreferrer">/.exec(consent.body)?.[1];
  expect(href).toBeDefined();
  const target = new URL(href!.replaceAll("&amp;", "&"));
  expect(target.origin + target.pathname).toBe(callback);
  expect(target.searchParams.get("state")).toBe(state);
  expect(target.searchParams.get("iss")).toBe(server.baseUrl.toString());
  const code = target.searchParams.get("code");
  expect(code).toBeTruthy();
  // Do not navigate to Google: this is a synthetic OAuth client, not platform validation.
  const exchange = await server.app.inject({ method: "POST", url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      redirect_uri: callback, code: code!, code_verifier: verifier }).toString() });
  expect(exchange.statusCode).toBe(200);
  const accessToken = exchange.json().access_token as string;
  const credential = await server.pairDevice(cookie, "Gemini isolated test Agent");
  const workDir = mkdtempSync(join(tmpdir(), "odr-gemini-e2e-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  const agent = await startRealAgent(credential, workDir);
  cleanups.push(() => agent.stop());
  const client = await connectMcpClient(server.baseUrl, accessToken);
  cleanups.push(() => client.close());
  const tools = await client.listTools();
  expect(tools.tools.map(t => t.name)).toEqual(expect.arrayContaining(["list_devices", "get_device_status"]));
  await waitFor(async () => {
    const result = await client.callTool({ name: "list_devices", arguments: {} });
    const devices = (result.structuredContent as { devices?: Array<{id: string; state: string}> })?.devices ?? [];
    return devices.some(d => d.id === credential.deviceId && d.state === "READY");
  }, 20_000);
  const status = await client.callTool({ name: "get_device_status", arguments: { deviceId: credential.deviceId } });
  expect(status.isError).not.toBe(true);
  expect(JSON.stringify(status.structuredContent)).toContain("READY");
  const initialize = await server.app.inject({method:"POST",url:"/mcp",
    headers:{authorization:"Bearer "+accessToken,accept:"application/json, text/event-stream"},
    payload:{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"fixture",version:"0.0.0"}}}});
  expect(initialize.statusCode).toBe(200);
  console.log("MCP response content type:", initialize.headers["content-type"]);
});
