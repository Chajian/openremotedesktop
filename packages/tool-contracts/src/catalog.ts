import {
  DESKTOP_COMMANDER_TOOL_MANIFEST,
  type DesktopCommanderToolDefinition,
  type DesktopCommanderToolManifestEntry,
} from "./manifest.js";

const supportedMetadata = new Set([
  "name", "title", "description", "inputSchema", "outputSchema", "annotations", "icons", "_meta",
]);

const remoteProcessGuidance = "Execution runs on the selected device. Use list_devices or get_device_status to identify its platform, and get_config on that device for its defaultShell, allowedDirectories, and runtime environment. Pass shell explicitly when a command requires a particular shell. Windows, macOS, and Linux use different shells and command syntax; container paths and mounts also belong to the selected device.";

/** Normalize only known host-dependent sections. Local adapter descriptions stay intact. */
export function publicToolDescription(name: string, description = ""): string {
  let portable = description
    .replace(/\n\n🐳 (?:CONTAINER|DOCKER|PODMAN|KUBERNETES): Verified mounts for persistent file operations: [^\n]+?\.\nFiles outside verified mounts may not persist after the container stops\./g, "")
    .replace(/\n\n🐳 (?:CONTAINER|DOCKER|PODMAN|KUBERNETES): Unverified mount candidates: [^\n]+?\. These paths are inferred from common container directories and may not persist\./g, "");
  if (name === "start_process" && portable.includes("Running on ")) {
    const runtimeSection = /Running on [^\n]+\. Default shell: [^\n]+\.[\s\S]*?(?=\n[ \t]*Examples:)/;
    if (!runtimeSection.test(portable)) throw new Error("Unrecognized start_process platform guidance; update the public catalog normalizer");
    portable = portable.replace(runtimeSection, remoteProcessGuidance);
  }
  return portable;
}

export function buildToolManifest(tools: readonly DesktopCommanderToolDefinition[]): DesktopCommanderToolManifestEntry[] {
  return tools.map(tool => {
    for (const field of Object.keys(tool)) {
      if (!supportedMetadata.has(field)) {
        throw new Error(`Unsupported tool metadata "${field}"; add explicit proxy support before regenerating the catalog`);
      }
    }
    const { _meta, ...definition } = structuredClone(tool);
    const metadata = publicToolMetadata(_meta);
    return {
      ...definition,
      description: publicToolDescription(tool.name, tool.description),
      ...(metadata === undefined ? {} : { _meta: metadata }),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function publicToolMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  // These bindings refer to local Desktop Commander resources. Relay v1 only
  // proxies tool calls, so publishing them would promise unservable UI assets.
  // All other metadata survives, including future fields within the ui object.
  delete metadata["ui/resourceUri"];
  delete metadata["openai/outputTemplate"];
  delete metadata["openai/widgetAccessible"];
  const ui = metadata.ui;
  if (ui !== null && typeof ui === "object" && !Array.isArray(ui)) {
    if ("resourceUri" in ui) delete ui.resourceUri;
    if (Object.keys(ui).length === 0) delete metadata.ui;
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

type ToolContract = {
  name: string;
  inputSchema?: Record<string, unknown> | undefined;
  outputSchema?: Record<string, unknown> | undefined;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Execution schemas only: platform text and optional hints do not change capability. */
export function canonicalToolCatalog(tools: readonly ToolContract[]): string {
  return canonical(tools.map(tool => ({
    name: tool.name,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
  })).sort((a, b) => a.name.localeCompare(b.name)));
}

export function assertDesktopCommanderCatalog(tools: readonly ToolContract[]): void {
  const actual = new Map(tools.map(tool => [tool.name, tool]));
  if (actual.size !== tools.length || actual.size !== DESKTOP_COMMANDER_TOOL_MANIFEST.length) {
    throw new Error("Desktop Commander tool catalog mismatch: unexpected tool count or duplicate names");
  }
  for (const expected of DESKTOP_COMMANDER_TOOL_MANIFEST) {
    const tool = actual.get(expected.name);
    if (!tool || canonicalToolCatalog([tool]) !== canonicalToolCatalog([expected])) {
      throw new Error(`Desktop Commander tool catalog mismatch: ${expected.name}; reinstall the matching Agent package`);
    }
  }
}
