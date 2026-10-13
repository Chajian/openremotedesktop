export type DeviceState =
  | "OFFLINE"
  | "CONNECTED"
  | "AUTHENTICATED"
  | "EXECUTOR_STARTING"
  | "READY"
  | "REVOKED"
  | "INCOMPATIBLE"
  | "EXECUTOR_FAILED";

const ALLOWED_TRANSITIONS: Readonly<Record<DeviceState, readonly DeviceState[]>> = {
  OFFLINE: ["CONNECTED", "REVOKED"],
  CONNECTED: ["AUTHENTICATED", "OFFLINE", "REVOKED"],
  AUTHENTICATED: ["EXECUTOR_STARTING", "READY", "OFFLINE", "REVOKED", "INCOMPATIBLE"],
  EXECUTOR_STARTING: [
    "READY",
    "EXECUTOR_FAILED",
    "OFFLINE",
    "REVOKED",
    "INCOMPATIBLE",
  ],
  READY: ["OFFLINE", "EXECUTOR_FAILED", "REVOKED", "INCOMPATIBLE"],
  REVOKED: [],
  INCOMPATIBLE: ["OFFLINE", "REVOKED"],
  EXECUTOR_FAILED: ["EXECUTOR_STARTING", "OFFLINE", "REVOKED"],
};

export class InvalidDeviceStateTransitionError extends Error {
  constructor(
    public readonly current: DeviceState,
    public readonly next: DeviceState,
  ) {
    super(`Invalid device state transition: ${current} -> ${next}`);
    this.name = "InvalidDeviceStateTransitionError";
  }
}

export function transitionDeviceState(
  current: DeviceState,
  next: DeviceState,
): DeviceState {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new InvalidDeviceStateTransitionError(current, next);
  }
  return next;
}

export function canAcceptToolCalls(state: DeviceState): boolean {
  return state === "READY";
}
