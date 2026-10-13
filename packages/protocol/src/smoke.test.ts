import { describe, expect, it } from "vitest";
import { PROTOCOL_PACKAGE_SENTINEL } from "./index.js";

describe("@open-desktop-remote/protocol", () => {
  it("exports its package sentinel", () => {
    expect(PROTOCOL_PACKAGE_SENTINEL).toBe("protocol");
  });
});
