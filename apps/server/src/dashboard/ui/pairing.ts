const CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
/** Uppercases, strips spaces and inserts the hyphen; returns null when the result is not a valid code. */
export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  const code = compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
  return CODE.test(code) ? code : null;
}
export type PairingError = "invalid" | "notFound" | "expired" | "used";
export type PairingValues = { userCode: string; friendlyName: string };
