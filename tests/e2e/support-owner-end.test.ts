import { describe, expect, it } from "vitest";
import { ExecutorManager, type ExecutorClient } from "../../apps/agent/src/executor/executor-manager.js";
import { runAgentConnect } from "../../apps/agent/src/runtime.js";
import { runSupportConnect } from "../../apps/agent/src/support/support-client.js";
import { startTestServer, waitFor } from "./helpers/test-server.js";

function csrf(html: string): string {
  const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error("Missing CSRF");
  return token;
}

describe("support owner end over actual Agent and Relay", () => {
  it("treats an authorized creator's close as normal after READY", async () => {
    const server = await startTestServer({ supportEnabled: true });
    const controller = new AbortController();
    let closes = 0;
    let running: Promise<void> | undefined;
    try {
      const cookie = await server.bootstrapAndLogin();
      const form = await fetch(new URL("/dashboard/support", server.baseUrl), { headers: { cookie } });
      const created = await fetch(new URL("/dashboard/support/create", server.baseUrl), {
        method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: csrf(await form.text()), label: "Owner finish" }),
      });
      expect(created.status).toBe(200);
      const invite = /\/support\/invite\/([A-Za-z0-9_-]{32})/.exec(await created.text())?.[1];
      if (!invite) throw new Error("Missing invitation");
      const createExecutor = () => new ExecutorManager({
        startClient: async (register): Promise<ExecutorClient> => {
          const client: ExecutorClient = {
            listTools: async () => [{ name: "read_file" }],
            callTool: async () => ({ content: [] }),
            close: async () => { closes++; },
          };
          register(client);
          return client;
        },
      });
      // Only the actual local executor implementation is substituted; the
      // support orchestrator, runtime, Relay, HTTP and WebSocket are real.
      running = runSupportConnect(server.baseUrl, invite, controller.signal, {
        consent: async () => true,
        deviceName: "Customer Windows", platform: "win32",
        runAgent: (url, signal, options) => runAgentConnect(url, signal, {
          ...options, createExecutor,
        }),
      });
      const outcome = running.then(() => "completed", error => error as unknown);
      await waitFor(() => server.relayRegistry.snapshot().some(s => s.state === "READY"), 15_000);
      const record = server.db.prepare("SELECT id, device_id AS deviceId FROM support_sessions")
        .get() as { id: string; deviceId: string };
      const confirm = await fetch(new URL(`/dashboard/support/${record.id}/end`, server.baseUrl),
        { headers: { cookie } });
      const ended = await fetch(new URL(`/dashboard/support/${record.id}/end`, server.baseUrl), {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: csrf(await confirm.text()) }),
      });
      expect(ended.status).toBe(303);
      const result = await Promise.race([
        outcome,
        new Promise<Error>(resolve => setTimeout(
          () => resolve(new Error("Support Agent did not exit")), 9_000)),
      ]);
      expect(result).toBe("completed");
      expect(closes).toBe(1);
      expect(server.db.prepare("SELECT ended_reason AS reason FROM support_sessions WHERE id=?")
        .get(record.id)).toEqual({ reason: "owner" });
      expect(server.relayRegistry.get(record.deviceId)).toBeUndefined();
    } finally {
      controller.abort();
      await running?.catch(() => undefined);
      await server.close();
    }
  }, 30_000);
});
