import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_SENTINEL } from "./index.js";

describe("@open-desktop-remote/shared", () => {
  it("exports its package sentinel", () => {
    expect(SHARED_PACKAGE_SENTINEL).toBe("shared");
  });
});
