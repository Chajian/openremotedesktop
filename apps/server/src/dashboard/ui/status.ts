import type { MessageKey } from "./i18n.js";
export type Tone = "ok" | "busy" | "err" | "off" | "revoked";
const TONES: Record<string, Tone> = {
  READY: "ok", CONNECTED: "busy", AUTHENTICATED: "busy", EXECUTOR_STARTING: "busy",
  EXECUTOR_FAILED: "err", INCOMPATIBLE: "err", OFFLINE: "off", REVOKED: "revoked",
};
export function deviceTone(state: string): Tone { return TONES[state] ?? "off"; }
/** Index of the current step on the 5-step rail (pair, connect, authenticate, start tools, ready). */
export function lifecycle(state: string): { current: number | null; failed: number | null } {
  const current = ({ CONNECTED: 1, AUTHENTICATED: 2, EXECUTOR_STARTING: 3, READY: 4 } as Record<string, number>)[state] ?? null;
  const failed = ({ EXECUTOR_FAILED: 3, INCOMPATIBLE: 2 } as Record<string, number>)[state] ?? null;
  return { current, failed };
}
const STATES = ["READY", "CONNECTED", "AUTHENTICATED", "EXECUTOR_STARTING", "EXECUTOR_FAILED", "INCOMPATIBLE", "OFFLINE", "REVOKED"] as const;
export function statusKeys(state: string): { label: MessageKey; desc: MessageKey; fix: MessageKey | null } {
  const known = STATES.find(value => value === state) ?? "OFFLINE";
  const fix: MessageKey | null = known === "OFFLINE" || known === "EXECUTOR_FAILED" || known === "INCOMPATIBLE" || known === "REVOKED" ? `status.${known}.fix` : null;
  return { label: `status.${known}.label`, desc: `status.${known}.desc`, fix };
}
