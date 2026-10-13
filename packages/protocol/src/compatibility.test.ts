import { describe, expect, it } from "vitest";
import {
  InvalidProtocolRangeError,
  negotiateProtocol,
} from "./index.js";

describe("protocol compatibility negotiation", () => {
  it("negotiates protocol v1 when both sides only support v1", () => {
    expect(
      negotiateProtocol({ min: 1, max: 1 }, { min: 1, max: 1 }),
    ).toEqual({ version: 1 });
  });

  it("chooses the highest common version for overlapping ranges", () => {
    expect(
      negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }),
    ).toEqual({ version: 3 });
  });

  it("returns PROTOCOL_INCOMPATIBLE for non-overlapping ranges", () => {
    expect(
      negotiateProtocol({ min: 1, max: 1 }, { min: 2, max: 3 }),
    ).toEqual({ error: "PROTOCOL_INCOMPATIBLE" });
  });

  it("rejects reversed or invalid ranges before negotiation", () => {
    const invalidRanges = [
      [{ min: 2, max: 1 }, { min: 1, max: 1 }],
      [{ min: 0, max: 1 }, { min: 1, max: 1 }],
      [{ min: 1.5, max: 2 }, { min: 1, max: 2 }],
    ] as const;

    for (const [agent, server] of invalidRanges) {
      let thrown: unknown;
      try {
        negotiateProtocol(agent, server);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidProtocolRangeError);
    }
  });
});
