const SENSITIVE_KEYS = new Set([
  "authorization",
  "accesstoken",
  "refreshtoken",
  "refreshcredential",
  "devicecode",
  "authorizationcode",
  "password",
  "arguments",
  "stdout",
  "stderr",
  "content",
  "screenshot",
  "cookie",
  "setcookie",
]);

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function redactSensitive(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizeKey(key))) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactSensitive(entry, seen);
    }
  }
  return output;
}
