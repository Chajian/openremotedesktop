import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { DESKTOP_COMMANDER_TOOL_MANIFEST } from "@open-desktop-remote/tool-contracts";
import { describe, expect, it, vi } from "vitest";
import { registerDesktopCommanderTools } from "./register-desktop-tools.js";

const sourceTool = vi.hoisted(() => ({
  name: "metadata_fixture",
  title: "Metadata fixture",
  description: "Return a structured fixture result.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { accepted: { type: "boolean" } },
    required: ["accepted"],
    additionalProperties: false,
  },
  annotations: {
    title: "Fixture annotation title",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  icons: [{
    src: "https://example.com/fixture.svg",
    mimeType: "image/svg+xml",
    sizes: ["any"],
    theme: "dark" as const,
  }],
  _meta: { "example.com/fixture": { label: "preserved", revision: 1 } },
}));

// Replace only the catalog source. Generation, routing-schema conversion,
// registration, serialization, and MCP tools/list all use their real code.
vi.mock("@open-desktop-remote/tool-contracts", async importOriginal => {
  const actual = await importOriginal<typeof import("@open-desktop-remote/tool-contracts")>();
  return {
    ...actual,
    DESKTOP_COMMANDER_TOOL_MANIFEST: actual.buildToolManifest([sourceTool]),
  };
});

describe("generated Desktop Commander metadata over MCP", () => {
  it("preserves optional metadata and output schemas while adding only optional input routing", async () => {
    const server = new McpServer({ name: "metadata-test-server", version: "0.0.0" });
    const client = new Client({ name: "metadata-test-client", version: "0.0.0" });
    registerDesktopCommanderTools(server, {
      authOwnerId: () => "fixture-owner",
      devices: { listOwnedDevices: () => [] },
      registry: { snapshot: () => [] },
      broker: { call: async () => { throw new Error("Listing tools must not dispatch an operation"); } },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const listed = tools.find(tool => tool.name === sourceTool.name);

      expect(listed).toMatchObject({
        name: sourceTool.name,
        title: sourceTool.title,
        description: sourceTool.description,
        annotations: sourceTool.annotations,
        icons: sourceTool.icons,
        _meta: sourceTool._meta,
      });
      expect(listed!.annotations).toEqual(sourceTool.annotations);
      expect(listed!.outputSchema).toEqual(sourceTool.outputSchema);
      expect(listed!.inputSchema).toMatchObject({
        type: "object",
        properties: { value: { type: "string" }, deviceId: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      });
      expect(listed!.inputSchema.required).not.toContain("deviceId");
      expect(DESKTOP_COMMANDER_TOOL_MANIFEST[0]!.inputSchema).toEqual(sourceTool.inputSchema);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
