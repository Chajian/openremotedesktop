import manifest from "./manifest.generated.json" with { type: "json" };

export type ToolAnnotations = {
  title?: string | undefined;
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
};

export type DesktopCommanderToolDefinition = {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  annotations?: ToolAnnotations | undefined;
  icons?: Array<{ src: string; mimeType?: string | undefined; sizes?: string[] | undefined; theme?: "light" | "dark" | undefined }> | undefined;
  _meta?: Record<string, unknown> | undefined;
};

export type DesktopCommanderToolManifestEntry = DesktopCommanderToolDefinition & { description: string };

export const DESKTOP_COMMANDER_TOOL_MANIFEST =
  manifest as DesktopCommanderToolManifestEntry[];
