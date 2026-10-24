import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DESKTOP_COMMANDER_TOOL_MANIFEST } from "./manifest.js";

// Input/output schema fingerprints captured from the 0.2.52 catalog at
// f01eefcbd4061d6597d4525610a8ec30431878e2. Descriptions and runtime paths are
// deliberately omitted. This fixed historical snapshot does not require Git
// history in CI and cannot silently change when the current manifest changes.
const legacySchemaHashes: Record<string, string> = {
  create_directory: "40c7dae4103af45cf11039dff458eae6ac5f2b2744a7c00e3d8614f5a8afb0ff",
  edit_block: "3c003517310342fd7549ada423e34e53ea14a34a894d747e994eeb5d5ec2564e",
  force_terminate: "dfac01045230c6c2c4026c408b033e58ff201908e81a0f9fa747de60453257d5",
  get_config: "4b2a349ae6065fe9d1d3677077bc2eef064dd8253891663c43a922b331879be6",
  get_file_info: "40c7dae4103af45cf11039dff458eae6ac5f2b2744a7c00e3d8614f5a8afb0ff",
  get_more_search_results: "771103b7b48e90d39e0cfc6bee585196fdd9561623b437c969a9543ca646c668",
  get_prompts: "9f307f947f1adb90d121553c732ef76bbf2290024febfbe2f49acac90d8e4747",
  get_recent_tool_calls: "d793bba743e5d81f51e9c5b6e82c983756d9cb93762c5455a2c37bb958a20a03",
  get_usage_stats: "ca70b7332029cabb5df74c3518518f35a331201be7ecc17c41d943db97e93fea",
  give_feedback_to_desktop_commander: "ca70b7332029cabb5df74c3518518f35a331201be7ecc17c41d943db97e93fea",
  interact_with_process: "639ffa3015c6c556acb16a111e84c4e3285c3aaf440c52c3c1205e1c4f3550fe",
  kill_process: "dfac01045230c6c2c4026c408b033e58ff201908e81a0f9fa747de60453257d5",
  list_directory: "1245f66a871b31e3cdaf249ab6d3280d6be0a93d50b9c291125af3900791835a",
  list_processes: "ca70b7332029cabb5df74c3518518f35a331201be7ecc17c41d943db97e93fea",
  list_searches: "ca70b7332029cabb5df74c3518518f35a331201be7ecc17c41d943db97e93fea",
  list_sessions: "ca70b7332029cabb5df74c3518518f35a331201be7ecc17c41d943db97e93fea",
  move_file: "930871d899a39d161eb77bd6b42bd1d439143b6ba1c4eef6de65fec5d0f65d0b",
  read_file: "3c1acac8372910d37ee19f621e6c230d262e4b1176e889be318fe6114e2b4e2a",
  read_multiple_files: "8bb0ea98c2ccc77714c059d295d8c9665c2515dc361c0d9adc64236992ef0d38",
  read_process_output: "9ff2102df760d4a89d79425b9cc60803440655ac9c3b41744a0408b006591731",
  set_config_value: "e19b98c4cd9e2c4c84923062966a31c8f178bfcf0d1545fcbfa425fab9311515",
  start_process: "0431a42f6123eee8f900e9bcac0ac060891be63b859b50571f63507ab7436e63",
  start_search: "e6b16f6b24f0e7e4c16da59aec979c2b68c23a1bdff8fca49e86bb39f8165416",
  stop_search: "92c4ec24e743fd7ed29ef3d755d93e0873aab6ac70fac4d811e76a8e4c2f4de4",
  write_file: "3450f893b98e23c3a4dc92772bfc3d6d946849bfa33304c35327b68d53307c88",
  write_pdf: "23e1b441d5df7a1df9a017c573f2f7b820e1ea0db924b641bc4587495eff02f9",
};

type NumericChange = {
  legacy: Record<string, unknown>;
  current: Record<string, unknown>;
};

// Every current value accepted by these tighter integer schemas is still a
// number accepted by 0.2.52. Do not widen the new public schema to the old one.
const numericNarrowings: Record<string, Record<string, NumericChange>> = {
  start_search: {
    contextLines: {
      legacy: { type: "number", default: 5 },
      current: { type: "integer", minimum: 0, default: 5 },
    },
    maxResults: {
      legacy: { type: "number" },
      current: { type: "integer", minimum: 0 },
    },
    timeout_ms: {
      legacy: { type: "number" },
      current: { type: "integer", minimum: 0 },
    },
  },
  get_more_search_results: {
    offset: {
      legacy: { type: "number", default: 0 },
      current: { type: "integer", default: 0 },
    },
    length: {
      legacy: { type: "number", default: 100 },
      current: { type: "integer", minimum: 1, default: 100 },
    },
  },
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

describe("Desktop Commander 0.2.52 and 0.3.1 contract compatibility", () => {
  it("publishes exactly the 25 legacy-supported tools after get_prompts was removed", () => {
    const legacyNames = Object.keys(legacySchemaHashes);
    expect(legacyNames).toHaveLength(26);
    const currentNames = DESKTOP_COMMANDER_TOOL_MANIFEST.map(tool => tool.name).sort();
    expect(currentNames).toEqual(legacyNames.filter(name => name !== "get_prompts").sort());
  });

  it.each(DESKTOP_COMMANDER_TOOL_MANIFEST)(
    "$name preserves its legacy contract apart from explicitly narrowed numeric inputs",
    tool => {
      const inputSchema = structuredClone(tool.inputSchema);
      const properties = inputSchema.properties as Record<string, unknown>;
      for (const [name, change] of Object.entries(numericNarrowings[tool.name] ?? {})) {
        // These independent literals ensure the comparison cannot hide a new
        // minimum, missing default, or accidental broadening to fractional input.
        expect(properties[name], `${tool.name}.${name}`).toEqual(change.current);
        properties[name] = change.legacy;
      }

      const outputSchema = "outputSchema" in tool ? tool.outputSchema : null;
      const fingerprint = createHash("sha256")
        .update(stableJson({ inputSchema, outputSchema: outputSchema ?? null }))
        .digest("hex");
      expect(fingerprint).toBe(legacySchemaHashes[tool.name]);
    },
  );
});
