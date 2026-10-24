import { describe, expect, it } from "vitest";
import { DesktopCommanderClient } from "./desktop-commander-client.js";
import { DESKTOP_COMMANDER_TOOL_MANIFEST } from "@open-desktop-remote/tool-contracts";

// Upstream 0.3.1 emits these two environment-dependent mount supplements.
// Match their exact wording so unrelated description changes remain visible.
const stableDescription = (description: string | undefined) =>
  (description ?? "")
    .replace(
      /\n\n🐳 (?:CONTAINER|DOCKER|PODMAN|KUBERNETES): Verified mounts for persistent file operations: [^\n]+?\.\nFiles outside verified mounts may not persist after the container stops\./g,
      "",
    )
    .replace(
      /\n\n🐳 (?:CONTAINER|DOCKER|PODMAN|KUBERNETES): Unverified mount candidates: [^\n]+?\. These paths are inferred from common container directories and may not persist\./g,
      "",
    );

describe("catalog path-guidance comparison", () => {
  it.each(["CONTAINER", "DOCKER", "PODMAN", "KUBERNETES"])(
    "ignores only %s runtime mount guidance",
    (label) => {
      const prefix = "Paths are automatically normalized.";
      const suffix = " Relative paths depend on the current working directory.";
      const verified = "\n\n🐳 " + label + ": Verified mounts for persistent file operations: /workspace, /mnt/data.\nFiles outside verified mounts may not persist after the container stops.";
      const unverified = "\n\n🐳 " + label + ": Unverified mount candidates: /workspace/candidate. These paths are inferred from common container directories and may not persist.";
      for (const guidance of [verified, unverified, verified + unverified]) {
        expect(stableDescription(prefix + guidance + suffix)).toBe(prefix + suffix);
        expect(stableDescription(prefix + guidance + suffix + " Changed guidance."))
          .toBe(prefix + suffix + " Changed guidance.");
      }
    },
  );

  it("keeps changes to the fixed mount warning visible", () => {
    const changed = [
      "\n\n🐳 CONTAINER: Verified mounts for persistent file operations: /workspace.\nFiles outside verified mounts always persist.",
      "\n\n🐳 CONTAINER: Unverified mount candidates: /workspace/candidate. These paths are persistent.",
    ];
    for (const description of changed) {
      expect(stableDescription(description)).toBe(description);
    }
  });
});

describe("Desktop Commander stdio compatibility", () => {
  it(
    "matches the complete public tool catalog and calls get_config",
    async () => {
      const client = await DesktopCommanderClient.start();
      try {
        const tools = await client.listTools();
        const names = new Set(tools.map((tool) => tool.name));

        // Upstream start_process descriptions include OS and configured shell.
        // Compare every executable schema, plus all platform-neutral descriptions.
        // Ignore only upstream's WSL/container mount-path supplement.
        // Tool names, schemas and all other descriptions remain strict.
        const contract = (tool: (typeof tools)[number]) => ({
          name: tool.name,
          description: tool.name === "start_process" ? undefined : stableDescription(tool.description),
          inputSchema: tool.inputSchema,
        });
        expect(tools.map(contract).sort((a, b) => a.name.localeCompare(b.name)))
          .toEqual(DESKTOP_COMMANDER_TOOL_MANIFEST.map(contract));

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

  it("confirms the owned Desktop Commander subprocess is gone before close resolves", async () => {
    const client = await DesktopCommanderClient.start();
    const transport = Reflect.get(client, "transport") as { pid: number | null };
    const pid = transport.pid;
    expect(pid).toBeGreaterThan(0);
    await client.close();
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 45_000);
});
