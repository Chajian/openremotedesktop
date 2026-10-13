import { describe, expect, it } from "vitest";
import { redactSensitive } from "./redaction.js";

describe("redactSensitive", () => {
  it("recursively redacts sensitive keys while preserving diagnostic metadata", () => {
    const input = {
      requestId: "req-1",
      deviceId: "dev-1",
      toolName: "read_file",
      durationMs: 12,
      errorCode: "DEVICE_OFFLINE",
      nested: {
        authorization: "Bearer secret",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        refreshCredential: "device-secret",
        deviceCode: "pair-secret",
        authorizationCode: "oauth-code",
        password: "passphrase",
        arguments: { path: "sensitive.txt" },
        stdout: "output",
        stderr: "error-output",
        content: "file body",
        screenshot: "base64-image",
      },
    };

    const redacted = redactSensitive(input) as Record<string, unknown>;
    expect(redacted).toMatchObject({
      requestId: "req-1",
      deviceId: "dev-1",
      toolName: "read_file",
      durationMs: 12,
      errorCode: "DEVICE_OFFLINE",
      nested: {
        authorization: "[REDACTED]",
        accessToken: "[REDACTED]",
        refreshToken: "[REDACTED]",
        refreshCredential: "[REDACTED]",
        deviceCode: "[REDACTED]",
        authorizationCode: "[REDACTED]",
        password: "[REDACTED]",
        arguments: "[REDACTED]",
        stdout: "[REDACTED]",
        stderr: "[REDACTED]",
        content: "[REDACTED]",
        screenshot: "[REDACTED]",
      },
    });
  });

  it("handles arrays, mixed key casing and circular references without mutating input", () => {
    const input: Record<string, unknown> = {
      ACCESS_TOKEN: "secret",
      children: [{ Password: "hidden", value: 3 }],
    };
    input.self = input;

    const redacted = redactSensitive(input) as Record<string, unknown>;
    expect(redacted.ACCESS_TOKEN).toBe("[REDACTED]");
    expect(redacted.children).toEqual([
      { Password: "[REDACTED]", value: 3 },
    ]);
    expect(redacted.self).toBe("[Circular]");
    expect(input.ACCESS_TOKEN).toBe("secret");
  });
});
