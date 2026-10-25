import { describe, expect, it } from "vitest";
import { DESKTOP_COMMANDER_TOOL_MANIFEST } from "./manifest.js";

describe("public Desktop Commander catalog", () => {
  it("retains annotations for every upstream tool", () => {
    expect(DESKTOP_COMMANDER_TOOL_MANIFEST).toHaveLength(25);
    for (const tool of DESKTOP_COMMANDER_TOOL_MANIFEST) {
      expect(tool).toHaveProperty("annotations.readOnlyHint");
      expect(tool).toHaveProperty("annotations.destructiveHint");
    }
  });

  it("directs runtime shell discovery to the selected device instead of a fixed host", () => {
    const description = DESKTOP_COMMANDER_TOOL_MANIFEST.find(tool => tool.name === "start_process")!.description;
    expect(description).not.toMatch(/Running on (Windows|macOS|Linux)/);
    expect(description).not.toMatch(/Default shell: (powershell|bash|zsh)/);
    expect(description).toContain("get_config");
    expect(description).toContain("selected device");
    expect(description).toContain("SMART DETECTION");
  });
});
