import { expect, it } from "vitest";
import { normalizePairingCode } from "./pairing.js";
it.each([
  ["k7qm4wxp", "K7QM-4WXP"], [" K7QM-4WXP ", "K7QM-4WXP"],
  ["k7qm-4wx", null], ["K7QM-4WX0", null], [42, null],
])("normalizes pairing input %s", (input, expected) => expect(normalizePairingCode(input)).toBe(expected));
