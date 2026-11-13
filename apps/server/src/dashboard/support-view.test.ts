import { describe, expect, it } from "vitest";
import type { SupportSession } from "../support/support-service.js";
import { renderSupportDashboard, renderCustomerSupport, type CustomerSupportOptions } from "./views/support.js";
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
const customer: CustomerSupportOptions = {
  locale: "en", baseUrl: ctx.publicBaseUrl, invite: "X".repeat(32),
  label: "Customer", expiresAt: 301000,
};

describe("support invitation duration", () => {
  it.each([
    ["en", "Invitation valid for", "Minutes", "Hours", "Days"],
    ["zh-CN", "邀请有效时长", "分钟", "小时", "天"],
  ] as const)("renders a localized, directly submittable duration in %s", (locale, label, minutes, hours, days) => {
    const page = renderSupportDashboard({...ctx, locale}, [], new Map(), true);
    const form = page.match(/<form\b[^>]*action="\/dashboard\/support\/create"[^>]*>[\s\S]*?<\/form>/)?.[0];
    expect(form).toBeDefined();
    expect(form).toContain('method="post"');
    expect(form).toContain('<input type="hidden" name="csrf" value="test">');
    expect(form).toContain(`<label for="support-invite-duration">${label}</label>`);
    const duration = form?.match(/<input\b[^>]*name="inviteDuration"[^>]*>/)?.[0];
    for (const attribute of ['type="number"', 'min="1"', 'max="10080"', 'step="1"', 'value="5"', 'required', 'aria-describedby="support-invite-duration-hint"']) {
      expect(duration).toContain(attribute);
    }
    const unit = form?.match(/<select\b[^>]*name="inviteDurationUnit"[^>]*>[\s\S]*?<\/select>/)?.[0];
    expect(unit).toContain('required');
    expect(unit).toContain(`<option value="minutes" selected>${minutes}</option>`);
    expect(unit).toContain(`<option value="hours">${hours}</option>`);
    expect(unit).toContain(`<option value="days">${days}</option>`);
    expect(form).toContain('id="support-invite-duration-hint"');
    expect(form).not.toContain('role="alert"');
  });

  it.each([
    ["en", "1 minute to 7 days"],
    ["zh-CN", "1 分钟至 7 天"],
  ] as const)("preserves submitted values and exposes a localized validation error in %s", (locale, range) => {
    const page = renderSupportDashboard({...ctx, locale}, [], new Map(), true, {
      label: 'Ticket "A" <customer>', inviteDuration: "8", inviteDurationUnit: "days", expiryError: true,
    });
    const label = page.match(/<input\b[^>]*name="label"[^>]*>/)?.[0];
    expect(label).toContain('value="Ticket &quot;A&quot; &lt;customer&gt;"');
    const duration = page.match(/<input\b[^>]*name="inviteDuration"[^>]*>/)?.[0];
    expect(duration).toContain('value="8"');
    expect(duration).toContain('aria-invalid="true"');
    expect(duration).toContain('aria-describedby="support-invite-duration-hint support-invite-duration-error"');
    const unit = page.match(/<select\b[^>]*name="inviteDurationUnit"[^>]*>[\s\S]*?<\/select>/)?.[0];
    expect(unit).toContain('aria-invalid="true"');
    expect(unit).toContain('<option value="days" selected>');
    const error = page.match(/<[^>]+id="support-invite-duration-error"[^>]*>[\s\S]*?<\/p>/)?.[0];
    expect(error).toContain(range);
    expect(page).toContain('role="alert"');
  });

  it("requires a unit to be chosen again after an unsupported submission", () => {
    const page = renderSupportDashboard(ctx, [], new Map(), true, {
      label: "Customer", inviteDuration: "2", inviteDurationUnit: 'weeks" autofocus', expiryError: true,
    });
    const unit = page.match(/<select\b[^>]*name="inviteDurationUnit"[^>]*>[\s\S]*?<\/select>/)?.[0];
    expect(unit).toBeDefined();
    expect(unit).toContain('<option value="" disabled selected>Choose a unit</option>');
    expect(unit).not.toContain('<option value="minutes" selected>');
    expect(page).not.toContain('weeks" autofocus');
  });

  it("shows the saved expiry belonging to each invitation in history", () => {
    const page = renderSupportDashboard(ctx, [
      {...base, label: "First customer", inviteExpiresAt: new Date(2026, 0, 2, 12, 30).getTime()},
      {...base, id: "second", label: "Second customer", inviteExpiresAt: new Date(2026, 0, 3, 14, 0).getTime()},
    ], new Map(), true);
    const cards = page.match(/<article\b[^>]*>[\s\S]*?<\/article>/g);
    expect(cards).toHaveLength(2);
    expect(cards?.[0]).toContain("First customer");
    expect(cards?.[0]).toContain("Invitation expires: Jan 2, 2026, 12:30 PM");
    expect(cards?.[1]).toContain("Second customer");
    expect(cards?.[1]).toContain("Invitation expires: Jan 3, 2026, 02:00 PM");
  });
});

describe("support history device link", () => {
  it("shows download choices only with the released installer, without adding a login", () => {
    const accelerated = renderCustomerSupport({...customer, installCommand: "verified-command", downloadSource: "npmmirror"});
    expect(accelerated).toContain("China acceleration");
    expect(accelerated).toContain("?os=win&amp;downloadSource=npmmirror");
    expect(accelerated).toContain("verified-command");
    expect(accelerated).not.toContain("/dashboard/login");
    const defaultPage = renderCustomerSupport(customer);
    expect(defaultPage).not.toContain("China acceleration");
    expect(defaultPage).toContain("PowerShell");
    expect(defaultPage).toContain(`pnpm --filter @open-desktop-remote/agent start -- agent support --server https://remote.example.com --invite ${customer.invite}`);
    expect(defaultPage).toContain('href="?os=win&amp;downloadSource=official" aria-current="page"');
  });
  it.each([
    ["win", "Windows", "OpenRemote-Support.cmd"],
    ["mac", "macOS", "OpenRemote-Support.command"],
    ["linux", "Linux", "OpenRemote-Support.sh"],
  ] as const)("renders %s instructions and preserves selections", (os, label, filename) => {
    const page = renderCustomerSupport({...customer, os, installCommand:"verified-command",
      downloadSource:"npmmirror", downloadUrl:`https://remote.example.com/${filename}`});
    expect(page).toContain(`href="https://remote.example.com/${filename}"`);
    expect(page).toContain(`Download ${label}`);
    expect(page).toContain(`href="?os=${os}&amp;downloadSource=npmmirror" aria-current="page"`);
    expect(page).toContain(`href="?os=${os}&amp;downloadSource=official"`);
    for (const choice of ["win", "mac", "linux"]) {
      expect(page).toContain(`href="?os=${choice}&amp;downloadSource=npmmirror"`);
    }
    if (os !== "win") expect(page).toContain(`bash ~/Downloads/${filename}`);
  });
  it("escapes customer content and command attributes", () => {
    const page = renderCustomerSupport({...customer, label:'<script>"customer"</script>',
      installCommand:'echo "<unsafe>" & exit', downloadUrl:'https://remote.example.com/?a="&b=<tag>'});
    expect(page).not.toContain('<script>"customer"</script>');
    expect(page).toContain('&lt;script&gt;&quot;customer&quot;&lt;/script&gt;');
    expect(page).toContain('data-copy="echo &quot;&lt;unsafe&gt;&quot; &amp; exit"');
    expect(page).toContain('href="https://remote.example.com/?a=&quot;&amp;b=&lt;tag&gt;"');
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
