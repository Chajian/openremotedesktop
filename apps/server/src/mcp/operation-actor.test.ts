import { expect, it } from "vitest";
import { createOperationActor } from "./operation-actor.js";
it("revalidates original token against the exact HTTP resource audience and actor", async () => {
  const calls: unknown[] = [];
  let valid = true;
  const oauth = { verifyAccessToken: async (token: string, resource: string) => { calls.push({ token, resource }); if (!valid)
      throw new Error("revoked"); return { ownerId: "owner", clientId: "client" }; } };
  const actor = createOperationActor(oauth as never, { token: "test-token", clientId: "client", scopes: ["mcp"], resource: new URL("https://alternate.example/mcp"), extra: { ownerId: "owner" } })!;
  expect(await actor.authorize()).toBe(true);
  expect(calls).toEqual([{ token: "test-token", resource: "https://alternate.example/mcp" }]);
  valid = false;
  expect(await actor.authorize()).toBe(false);
  expect(createOperationActor(oauth as never, { token: "test-token", clientId: "client", scopes: [], extra: { ownerId: "owner" } })).toBeNull();
});
