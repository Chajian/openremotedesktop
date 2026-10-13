import manifest from "./manifest.generated.json" with { type: "json" };

export type DesktopCommanderToolManifestEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const DESKTOP_COMMANDER_TOOL_MANIFEST =
  manifest as DesktopCommanderToolManifestEntry[];
