import { describe, expect, it } from "vitest";
import { loadServerConfig } from "../config.js";
import { renderGeminiNavigation, usesGeminiNavigation, validateGeminiLocation } from "./callback-response.js";

const origin = "https://oauth-redirect.googleusercontent.com";
const uri = origin + "/r/fixture?fixed=one&fixed=two&encoded=%22%26";
const issuer = "https://odr.example.test/";
const state = 'state & " Unicode 雪';
const callback = uri + "&" + new URLSearchParams({ code: "fixture-code", state, iss: issuer });

describe("Gemini callback navigation", () => {
  it("defaults off and parses only explicit boolean strings", () => {
    expect(loadServerConfig({}).geminiCallbackCompatEnabled).toBe(false);
    expect(loadServerConfig({ ODR_GEMINI_CALLBACK_COMPAT_ENABLED: "false" }).geminiCallbackCompatEnabled).toBe(false);
    expect(loadServerConfig({ ODR_GEMINI_CALLBACK_COMPAT_ENABLED: "true" }).geminiCallbackCompatEnabled).toBe(true);
    for (const value of ["", "TRUE", "1", "yes", origin]) {
      expect(() => loadServerConfig({ ODR_GEMINI_CALLBACK_COMPAT_ENABLED: value })).toThrow();
    }
  });
  it("only selects the exact enabled HTTPS callback origin and supported path", () => {
    expect(usesGeminiNavigation(uri, false)).toBe(false);
    expect(usesGeminiNavigation(uri, true)).toBe(true);
    const withUserInfo = new URL(origin + "/r/fixture");
    withUserInfo.username = "fixture-user";
    for (const invalid of [undefined, "not-a-url", "https://client.example/callback",
      "http://oauth-redirect.googleusercontent.com/r/fixture",
      "https://oauth-redirect.googleusercontent.com.evil.example/r/fixture",
      "https://evil.googleusercontent.com/r/fixture",
      withUserInfo.toString(),
      origin + ":444/r/fixture", origin + "/r/", origin + "/r-other/fixture",
      origin + "/r/fixture#fragment", origin + "/r/fi\nxture", origin + "/r/ fixture"]) {
      expect(usesGeminiNavigation(invalid, true), invalid).toBe(false);
    }
  });
  it("preserves the original URL including duplicate fixed parameters and encoded state", () => {
    expect(validateGeminiLocation(uri, callback, "approved", issuer, state)).toBe(callback);
    const denied = uri + "&" + new URLSearchParams({ error: "access_denied", iss: issuer, state });
    expect(validateGeminiLocation(uri, denied, "denied", issuer, state)).toBe(denied);
    const absentState = uri + "&" + new URLSearchParams({ code: "fixture-code", iss: issuer });
    expect(validateGeminiLocation(uri, absentState, "approved", issuer, undefined)).toBe(absentState);
  });
  it("fails closed on callback mismatch, unknown/duplicate fields, ambiguous fixed parameters or altered state", () => {
    for (const invalid of [
      undefined, "/dashboard/login", callback.replace(origin, "https://evil.example"),
      callback.replace("/r/fixture", "/r/other"), callback.replace("fixed=two", "fixed=changed"),
      callback.replace("fixed=one&fixed=two", "fixed=two&fixed=one"),
      callback.replace("code=fixture-code", "code="), callback.replace("code=fixture-code", "error=access_denied"),
      callback + "&code=second", callback + "&state=other", callback + "&error=access_denied",
      callback + "&unexpected=value", callback + "#fragment", callback + "\n",
      callback.replace(encodeURIComponent(issuer), encodeURIComponent("https://other.example/")),
    ]) {
      expect(() => validateGeminiLocation(uri, invalid, "approved", issuer, state), String(invalid)).toThrow();
    }
    expect(() => validateGeminiLocation(uri + "&code=preexisting", callback, "approved", issuer, state)).toThrow();
    expect(() => validateGeminiLocation(uri, callback, "denied", issuer, state)).toThrow();
  });
  it("uses escaped HTML attributes, no scripts/forms or resources and accurate outcome text", () => {
    const value = origin + '/r/fixture?x="><script>alert(1)</script>&y=雪';
    const page = renderGeminiNavigation(value, "approved");
    expect(page).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;y=雪');
    expect(page).not.toMatch(/<(?:script|img|link|form)\b/i);
    expect(page).toContain('rel="noreferrer"');
    expect(page).toContain('http-equiv="refresh"');
    expect(page).toContain("Authorization approved");
    expect(renderGeminiNavigation(callback, "denied")).toContain("Authorization denied");
    expect(renderGeminiNavigation(callback, "denied")).not.toContain("Authorization approved");
  });
});
