import { describe, expect, it } from "vitest";
import { addDeviceIdToToolSchema } from "./remote-tool-schema.js";

describe("addDeviceIdToToolSchema", () => {
  it("preserves the original properties and adds optional deviceId", () => {
    const remote = addDeviceIdToToolSchema({
      name: "read_file",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    });

    expect(remote.inputSchema).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        deviceId: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("does not make deviceId required", () => {
    const remote = addDeviceIdToToolSchema({
      name: "get_config",
      description: "Get config",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    });

    expect(remote.inputSchema.required).toEqual([]);
  });

  it("rejects a source schema that already defines deviceId", () => {
    expect(() =>
      addDeviceIdToToolSchema({
        name: "conflicting_tool",
        description: "Conflict",
        inputSchema: {
          type: "object",
          properties: { deviceId: { type: "number" } },
        },
      }),
    ).toThrow(/deviceId/i);
  });
});
