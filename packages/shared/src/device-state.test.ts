import { describe, expect, it } from "vitest";
import {
  InvalidDeviceStateTransitionError,
  canAcceptToolCalls,
  transitionDeviceState,
  type DeviceState,
} from "./index.js";

function transitionSequence(states: DeviceState[]): DeviceState {
  let current = states[0]!;
  for (const next of states.slice(1)) {
    current = transitionDeviceState(current, next);
  }
  return current;
}

describe("device state machine", () => {
  it("allows the normal startup path to READY", () => {
    expect(
      transitionSequence([
        "OFFLINE",
        "CONNECTED",
        "AUTHENTICATED",
        "EXECUTOR_STARTING",
        "READY",
      ]),
    ).toBe("READY");
  });

  it("allows READY to become OFFLINE on transport disconnect", () => {
    expect(transitionDeviceState("READY", "OFFLINE")).toBe("OFFLINE");
  });

  it("allows an authenticated reconnect to reassert an already-READY executor", () => {
    expect(transitionDeviceState("AUTHENTICATED", "READY")).toBe("READY");
  });

  it("allows executor failure and bounded restart recovery", () => {
    expect(
      transitionSequence([
        "READY",
        "EXECUTOR_FAILED",
        "EXECUTOR_STARTING",
        "READY",
      ]),
    ).toBe("READY");
  });

  it("never allows a revoked device to reconnect", () => {
    expect(() => transitionDeviceState("REVOKED", "CONNECTED")).toThrow(
      InvalidDeviceStateTransitionError,
    );
  });

  it("does not allow incompatible devices to jump to READY", () => {
    expect(() => transitionDeviceState("INCOMPATIBLE", "READY")).toThrow(
      InvalidDeviceStateTransitionError,
    );
  });

  it("accepts tool calls only in READY", () => {
    const states: DeviceState[] = [
      "OFFLINE",
      "CONNECTED",
      "AUTHENTICATED",
      "EXECUTOR_STARTING",
      "READY",
      "REVOKED",
      "INCOMPATIBLE",
      "EXECUTOR_FAILED",
    ];

    for (const state of states) {
      expect(canAcceptToolCalls(state)).toBe(state === "READY");
    }
  });
});
