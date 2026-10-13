import { describe, expect, it } from "vitest";
import { DesktopCommanderClient } from "./desktop-commander-client.js";

describe("Desktop Commander stdio compatibility", () => {
  it(
    "initializes, lists representative tools, and calls get_config",
    async () => {
      const client = await DesktopCommanderClient.start();
      try {
        const tools = await client.listTools();
        const names = new Set(tools.map((tool) => tool.name));

        expect(tools.length).toBeGreaterThan(5);
        expect(names.has("read_file")).toBe(true);
        expect(names.has("start_process")).toBe(true);
        expect(names.has("get_config")).toBe(true);

        const result = await client.callTool("get_config", {});
        expect(result.isError).not.toBe(true);
        expect(Array.isArray(result.content)).toBe(true);
      } finally {
        await client.close();
      }
    },
    45_000,
  );

  it(
    "notifies a registered close listener when the local MCP process closes",
    async () => {
      const client = await DesktopCommanderClient.start();
      let closed = false;
      client.onClose(() => {
        closed = true;
      });

      await client.close();

      expect(closed).toBe(true);
    },
    45_000,
  );
});
