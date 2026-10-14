import { describe, expect, it } from "vitest";
import { deviceTone, lifecycle, statusKeys } from "./status.js";
import { catalogKeys } from "./i18n.js";
const cases = [["READY", "ok"], ["CONNECTED", "busy"], ["AUTHENTICATED", "busy"], ["EXECUTOR_STARTING", "busy"], ["EXECUTOR_FAILED", "err"], ["INCOMPATIBLE", "err"], ["OFFLINE", "off"], ["REVOKED", "revoked"]] as const;
describe("device status presentation", () => {
  it.each(cases)("maps %s to %s", (state, tone) => expect(deviceTone(state)).toBe(tone));
  it.each([
    { state: "READY", current: 4, failed: null },
    { state: "EXECUTOR_FAILED", current: null, failed: 3 },
    { state: "INCOMPATIBLE", current: null, failed: 2 },
    { state: "OFFLINE", current: null, failed: null },
  ])("maps the lifecycle for $state", ({ state, current, failed }) => expect(lifecycle(state)).toEqual({ current, failed }));
  it("uses an offline fallback for an unknown state", () => {
    expect(deviceTone("unknown")).toBe("off");
    expect(statusKeys("unknown")).toEqual(statusKeys("OFFLINE"));
  });
  it("provides bilingual label, description and recovery keys", () => {
    for (const [state] of cases) {
      const keys = statusKeys(state);
      for (const locale of ["en", "zh-CN"] as const) {
        expect(catalogKeys(locale)).toContain(keys.label);
        expect(catalogKeys(locale)).toContain(keys.desc);
        if (keys.fix) expect(catalogKeys(locale)).toContain(keys.fix);
      }
    }
  });
});
