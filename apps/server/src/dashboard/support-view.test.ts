import { describe, expect, it } from "vitest";
import type { SupportSession } from "../support/support-service.js";
import { renderSupportDashboard, renderCustomerSupport } from "./views/support.js";
import type { ShellContext } from "./ui/components.js";

const ctx: ShellContext = {
  locale: "en", account: null, nav: "support", path: "/dashboard/support",
  csrf: "test", publicBaseUrl: new URL("https://remote.example.com"),
};
const base: SupportSession = {
  id: "session", label: "Customer", createdAt: 1, inviteExpiresAt: 301000,
  joinedAt: 2, deviceId: "device123", endedAt: null, endedReason: null,
  state: "active", deviceAccessible: true,
};

describe("support history device link", () => {
  it("shows download choices only with the released installer, without adding a login", () => {
    const accelerated = renderCustomerSupport("en", ctx.publicBaseUrl, "X".repeat(32), "Customer", 301000, "verified-command", "npmmirror");
    expect(accelerated).toContain("China acceleration");
    expect(accelerated).toContain("?downloadSource=npmmirror");
    expect(accelerated).toContain("verified-command");
    expect(accelerated).not.toContain("/dashboard/login");
    expect(renderCustomerSupport("en", ctx.publicBaseUrl, "X".repeat(32), "Customer", 301000)).not.toContain("China acceleration");
  });
  it("links a live accessible device, not an ended or removed device", () => {
    const connected = renderSupportDashboard(ctx, [base], new Map([["device123", "READY"]]), true);
    expect(connected).toContain('href="/dashboard/devices/device123"');
    const ended = renderSupportDashboard(ctx, [{ ...base,
      state: "ended", endedAt: 10, endedReason: "owner" }],
      new Map(), true);
    expect(ended).not.toContain('href="/dashboard/devices/device123"');
    expect(ended).toContain("device123".slice(0, 8));
  });
});
