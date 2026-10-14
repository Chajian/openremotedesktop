import { describe, expect, it } from "vitest";
import { catalogKeys, formatRelative, resolveLocale, safeLangReturnTo, t } from "./i18n.js";

describe("locale resolution", () => {
  it("prefers the cookie, then Accept-Language, then English", () => {
    expect(resolveLocale({ cookie: "a=1; odr_lang=zh-CN", acceptLanguage: "en-US" })).toBe("zh-CN");
    expect(resolveLocale({ acceptLanguage: "zh-TW,zh;q=0.9,en;q=0.8" })).toBe("zh-CN");
    expect(resolveLocale({ acceptLanguage: "en;q=0.4, zh;q=0.9" })).toBe("zh-CN");
    expect(resolveLocale({ acceptLanguage: "fr-FR,en;q=0.5" })).toBe("en");
    expect(resolveLocale({ acceptLanguage: "fr" })).toBe("en");
    expect(resolveLocale({ cookie: "odr_lang=de" })).toBe("en");
    expect(resolveLocale({})).toBe("en");
  });
});

describe("catalogs", () => {
  it("have identical keys and interpolate params", () => {
    expect(catalogKeys("zh-CN")).toEqual(catalogKeys("en"));
    expect(t("en", "common.devicesCount", { count: 3 })).toContain("3");
  });
});

describe("safeLangReturnTo", () => {
  it("allows dashboard, device and authorize paths only", () => {
    expect(safeLangReturnTo("/dashboard/devices/abc?f=online")).toBe("/dashboard/devices/abc?f=online");
    expect(safeLangReturnTo("/device")).toBe("/device");
    expect(safeLangReturnTo("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
    for (const bad of ["//evil.example", "https://evil.example", "/auth/github", "/dashboard/../auth/github", "/dashboard#x", "/dashboard\\x", 42]) {
      expect(safeLangReturnTo(bad)).toBe("/dashboard");
    }
  });
});

describe("formatRelative", () => {
  it("formats recent times in both locales", () => {
    const now = Date.UTC(2026, 9, 12, 3, 0, 0);
    expect(formatRelative("en", now - 10_000, now)).toBe(t("en", "time.justNow"));
    expect(formatRelative("en", now - 5 * 60_000, now)).toContain("5");
    expect(formatRelative("zh-CN", now - 2 * 86_400_000, now)).toContain("2");
    expect(formatRelative("en", null, now)).toBe(t("en", "time.never"));
  });
});

it("rejects encoded dot segments that resolve outside the language return whitelist", () => {
  const candidate = "/dashboard/%2e%2e/auth/github";
  expect(new URL(candidate, "https://remote.example.com").pathname).toBe("/auth/github");
  expect(safeLangReturnTo(candidate)).toBe("/dashboard");
});

it("normalizes safe dot segments and rejects mixed-case encoded traversal", () => {
  for (const bad of ["/dashboard/.%2E/auth/github", "/dashboard/%2E./x"]) expect(safeLangReturnTo(bad)).toBe("/dashboard");
  expect(safeLangReturnTo("/dashboard/./devices")).toBe("/dashboard/devices");
});
