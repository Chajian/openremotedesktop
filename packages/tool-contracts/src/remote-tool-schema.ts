import type { DesktopCommanderToolManifestEntry } from "./manifest.js";

export type RemoteToolDefinition = DesktopCommanderToolManifestEntry;

type JsonObjectSchema = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  [key: string]: unknown;
};

export function addDeviceIdToToolSchema(
  tool: DesktopCommanderToolManifestEntry,
): RemoteToolDefinition {
  const source = structuredClone(tool.inputSchema) as JsonObjectSchema;
  const properties = source.properties ?? {};

  if (Object.prototype.hasOwnProperty.call(properties, "deviceId")) {
    throw new Error(
      `Desktop Commander tool "${tool.name}" already defines deviceId`,
    );
  }

  return {
    ...tool,
    inputSchema: {
      ...source,
      type: source.type ?? "object",
      properties: {
        ...properties,
        deviceId: {
          type: "string",
          description:
            "Target device id. Omit only when exactly one device is READY.",
        },
      },
    },
  };
}
