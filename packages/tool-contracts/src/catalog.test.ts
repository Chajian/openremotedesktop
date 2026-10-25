import { describe, expect, it } from "vitest";
import { assertDesktopCommanderCatalog, buildToolManifest, canonicalToolCatalog, publicToolDescription } from "./catalog.js";
import { DESKTOP_COMMANDER_TOOL_MANIFEST } from "./manifest.js";

const inputSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };

describe("manifest generation", () => {
  it("preserves every supported optional metadata field during generation", () => {
    const source = {
      name: "fixture", title: "Fixture", description: "Useful behavior", inputSchema,
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      annotations: { title: "Fixture title", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      icons: [{ src: "https://example.com/icon.svg", mimeType: "image/svg+xml", sizes: ["any"], theme: "light" as const }],
      _meta: { "example.com/optional": { label: "preserved" } },
    };
    expect(buildToolManifest([source])).toEqual([source]);
  });

  it("requires deliberate support for newly added top-level metadata", () => {
    const future = { name: "fixture", inputSchema, futureMetadata: { enabled: true } };
    expect(() => buildToolManifest([future])).toThrow(/Unsupported tool metadata.*futureMetadata/);
  });

  it("omits only local UI bindings that the Relay cannot serve, preserving other metadata", () => {
    const source = {
      name: "fixture", inputSchema,
      annotations: { readOnlyHint: true },
      _meta: {
        "ui/resourceUri": "ui://desktop-commander/file-preview",
        ui: { resourceUri: "ui://desktop-commander/file-preview", futureDisplayHint: "preserve" },
        "openai/outputTemplate": "ui://desktop-commander/file-preview",
        "openai/widgetAccessible": true,
        "example.com/optional": { label: "preserved" },
      },
    };
    const [tool] = buildToolManifest([source]);
    expect(tool!._meta).toEqual({ ui: { futureDisplayHint: "preserve" }, "example.com/optional": { label: "preserved" } });
    expect(tool!.annotations).toEqual(source.annotations);
    expect(source._meta.ui.resourceUri).toBe("ui://desktop-commander/file-preview");
  });

  it.each([
    ["Windows", "powershell.exe", "WINDOWS-SPECIFIC TROUBLESHOOTING"],
    ["macOS", "/bin/zsh", "MACOS-SPECIFIC NOTES"],
    ["Linux (Docker Container)", "/bin/bash", "LINUX-SPECIFIC NOTES"],
  ])("publishes portable guidance for %s while retaining the runtime source", (platform, shell, heading) => {
    const description = `Start a terminal.\nRunning on ${platform}. Default shell: ${shell}.\n${heading}:\nRuntime guidance.\n    Examples:\nExample command.\nSMART DETECTION: Useful behavior.`;
    const source = { name: "start_process", inputSchema, description };
    const [tool] = buildToolManifest([source]);
    expect(tool!.description).not.toContain(`Running on ${platform}`);
    expect(tool!.description).toContain("get_config");
    expect(tool!.description).toContain("selected device");
    expect(tool!.description).toContain("Example command.");
    expect(tool!.description).toContain("SMART DETECTION: Useful behavior.");
    expect(source.description).toBe(description);
    expect(tool!.inputSchema).toEqual(inputSchema);
  });

  it("fails visibly if the runtime platform section no longer has the known boundary", () => {
    expect(() => publicToolDescription("start_process", "Running on Windows. Default shell: powershell.exe. New format."))
      .toThrow(/platform guidance/);
  });
});

describe("executor catalog validation", () => {
  it("accepts reordered tools and schema keys without depending on descriptions or metadata", () => {
    const tools = DESKTOP_COMMANDER_TOOL_MANIFEST.map(tool => ({ ...tool, description: "Runtime-specific description", annotations: { readOnlyHint: false }, inputSchema: Object.fromEntries(Object.entries(tool.inputSchema).reverse()) })).reverse();
    expect(() => assertDesktopCommanderCatalog(tools)).not.toThrow();
    expect(canonicalToolCatalog(tools)).toBe(canonicalToolCatalog(DESKTOP_COMMANDER_TOOL_MANIFEST));
  });

  it("rejects an incomplete catalog even when it is nonempty", () => {
    expect(() => assertDesktopCommanderCatalog(DESKTOP_COMMANDER_TOOL_MANIFEST.slice(1))).toThrow(/catalog mismatch/);
  });

  it("rejects duplicate names", () => {
    const tools = [...DESKTOP_COMMANDER_TOOL_MANIFEST];
    tools[1] = tools[0]!;
    expect(() => assertDesktopCommanderCatalog(tools)).toThrow(/catalog mismatch/);
  });

  it.each([undefined, { type: "object", properties: {} }])("rejects missing or changed input schemas", inputSchema => {
    const tools = DESKTOP_COMMANDER_TOOL_MANIFEST.map((tool, index) => index === 0 ? { name: tool.name, ...(inputSchema ? { inputSchema } : {}) } : tool);
    expect(() => assertDesktopCommanderCatalog(tools)).toThrow(/catalog mismatch/);
  });

  it("rejects output schema drift", () => {
    const tools = DESKTOP_COMMANDER_TOOL_MANIFEST.map((tool, index) => index === 0 ? { ...tool, outputSchema: { type: "object" } } : tool);
    expect(() => assertDesktopCommanderCatalog(tools)).toThrow(/catalog mismatch/);
  });
});
