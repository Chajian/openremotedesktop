import { describe, expect, it } from "vitest";
import type { SupportSession } from "../support/support-service.js";
import { renderSupportDashboard, renderSupportCreated, renderCustomerSupport, type CustomerSupportOptions } from "./views/support.js";
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
    expect(unit).toContain('data-duration-input="support-invite-duration"');
    expect(unit).toContain(`<option value="minutes" data-max="10080" selected>${minutes}</option>`);
    expect(unit).toContain(`<option value="hours" data-max="168">${hours}</option>`);
    expect(unit).toContain(`<option value="days" data-max="7">${days}</option>`);
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
    expect(duration).toContain('max="7"');
    expect(duration).toContain('aria-invalid="true"');
    expect(duration).toContain('aria-describedby="support-invite-duration-hint support-invite-duration-error"');
    const unit = page.match(/<select\b[^>]*name="inviteDurationUnit"[^>]*>[\s\S]*?<\/select>/)?.[0];
    expect(unit).toContain('aria-invalid="true"');
    expect(unit).toContain('<option value="days" data-max="7" selected>');
    const error = page.match(/<[^>]+id="support-invite-duration-error"[^>]*>[\s\S]*?<\/p>/)?.[0];
    expect(error).toContain(range);
    expect(page).toContain('role="alert"');
  });

  it.each([
    ["minutes", "10080", "10081"],
    ["hours", "168", "169"],
    ["days", "7", "8"],
  ])("renders the %s limit consistently before and after validation", (unit, max, value) => {
    for (const expiryError of [false, true]) {
      const page = renderSupportDashboard(ctx, [], new Map(), true, {
        inviteDuration: value, inviteDurationUnit: unit, expiryError,
      });
      const duration = page.match(/<input\b[^>]*name="inviteDuration"[^>]*>/)?.[0];
      for (const attribute of ['min="1"', `max="${max}"`, 'step="1"', `value="${value}"`]) {
        expect(duration).toContain(attribute);
      }
      expect(page).toContain(`<option value="${unit}" data-max="${max}" selected>`);
    }
  });

  it("requires a unit to be chosen again after an unsupported submission", () => {
    const page = renderSupportDashboard(ctx, [], new Map(), true, {
      label: "Customer", inviteDuration: "2", inviteDurationUnit: 'weeks" autofocus', expiryError: true,
    });
    const unit = page.match(/<select\b[^>]*name="inviteDurationUnit"[^>]*>[\s\S]*?<\/select>/)?.[0];
    expect(unit).toBeDefined();
    expect(unit).toContain('<option value="" disabled selected>Choose a unit</option>');
    expect(unit).not.toContain('<option value="minutes" data-max="10080" selected>');
    expect(page).not.toContain('weeks" autofocus');
  });

  it("shows the saved expiry belonging to each invitation in history", () => {
    const page = renderSupportDashboard(ctx, [
      {...base, label: "First customer", inviteExpiresAt: Date.UTC(2026, 0, 2, 12, 30, 5)},
      {...base, id: "second", label: "Second customer", inviteExpiresAt: Date.UTC(2026, 0, 3, 14, 0, 25)},
    ], new Map(), true);
    const cards = page.match(/<article\b[^>]*>[\s\S]*?<\/article>/g);
    expect(cards).toHaveLength(2);
    expect(cards?.[0]).toContain("First customer");
    expect(cards?.[0]).toContain("Jan 2, 2026, 12:30:05 UTC");
    expect(cards?.[0]).toContain('datetime="2026-01-02T12:30:05.000Z"');
    expect(cards?.[1]).toContain("Second customer");
    expect(cards?.[1]).toContain("Jan 3, 2026, 14:00:25 UTC");
    expect(cards?.[1]).toContain('datetime="2026-01-03T14:00:25.000Z"');
  });
});

describe("support invitation summary", () => {
  const createdAt = Date.UTC(2026, 0, 2, 23, 59, 35);
  const downloads = {
    win: "https://remote.example.com/support/invite/test/OpenRemote-Support.cmd",
    mac: "https://remote.example.com/support/invite/test/OpenRemote-Support.command",
    linux: "https://remote.example.com/support/invite/test/OpenRemote-Support.sh",
  };

  it.each([
    [1, "1 minute", "1分钟"], [5, "5 minutes", "5分钟"],
    [120, "2 hours", "2小时"], [10080, "7 days", "7天"],
  ] as const)("shows the original %s minute validity even when rendered after creation", (minutes, english, chinese) => {
    const session = {...base, createdAt, inviteExpiresAt: createdAt + minutes * 60_000};
    expect(renderSupportCreated(ctx, customer.invite, session)).toContain(english);
    expect(renderSupportCreated({...ctx, locale:"zh-CN"}, customer.invite, session)).toContain(chinese);
  });

  it.each([false, true])("keeps validity, exact deadline and manual-end explanation ahead of downloads (enabled=%s)", (enabled) => {
    const session = {...base, createdAt, inviteExpiresAt: Date.UTC(2026, 0, 3, 0, 4, 35)};
    const page = renderSupportCreated(ctx, customer.invite, session, enabled ? downloads : undefined);
    const copy = page.indexOf("Copy invite link");
    for (const text of ["Invitation valid for", "5 minutes", "Jan 3, 2026, 00:04:35 UTC"]) {
      expect(page.indexOf(text)).toBeGreaterThan(-1);
      expect(page.indexOf(text)).toBeLessThan(copy);
    }
    expect(page).toContain('datetime="2026-01-03T00:04:35.000Z"');
    const manualEnd = page.indexOf("After the customer connects, only you or the customer can end the session.");
    expect(manualEnd).toBeGreaterThan(copy);
    if (enabled) {
      const detailsStart = page.indexOf("<details");
      expect(detailsStart).toBeGreaterThan(manualEnd);
      const details = page.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
      expect(details).toBeDefined();
      expect(details).toContain("<summary>");
      expect(details?.match(/<a\b[^>]*class="btn /g)).toHaveLength(3);
      expect(details?.match(/<button\b[^>]*data-copy=/g)).toHaveLength(6);
      for (const url of Object.values(downloads)) {
        expect(details).toContain(`href="${url}"`);
        expect(details).toContain(`data-copy="${url}"`);
        expect(details).toContain(`data-copy="${url}?downloadSource=npmmirror"`);
      }
      expect(details).not.toContain("Invitation expires");
      expect(details).not.toContain("After the customer connects");
    } else {
      expect(page).not.toContain("<details");
      expect(page).not.toContain("OpenRemote-Support.cmd");
    }
  });

  it("renders the same exact UTC deadline on success, history and customer pages", () => {
    const expiresAt = Date.UTC(2026, 0, 3, 0, 4, 35);
    const session = {...base, createdAt, inviteExpiresAt:expiresAt};
    for (const page of [
      renderSupportCreated(ctx, customer.invite, session),
      renderSupportDashboard(ctx, [session], new Map(), true),
      renderCustomerSupport({...customer, expiresAt}),
    ]) {
      expect(page).toContain("Jan 3, 2026, 00:04:35 UTC");
      expect(page).toContain('datetime="2026-01-03T00:04:35.000Z"');
    }
  });

  it.each(["en", "zh-CN"] as const)("gives the recipient direct platform instructions while preserving manual consent in %s", (locale) => {
    for (const os of ["win", "mac", "linux"] as const) {
      const page = renderCustomerSupport({...customer, locale, os, installCommand:"verified-command", downloadUrl:downloads[os]});
      const downloadSection = page.slice(page.indexOf("</h1>"), page.indexOf("<details"));
      expect(downloadSection).not.toContain(locale === "en" ? "Send this download link to the customer" : "将下载链接发给客户");
      expect(downloadSection).toContain(locale === "en" ? "Choose this computer's operating system".replace("'", "&#39;") : "选择这台电脑的操作系统");
      expect(downloadSection).toContain(locale === "en" ? "Only run it if you trust the requester" : "仅在信任协助方时运行");
      expect(downloadSection).toContain(locale === "en" ? "without a confirmation prompt" : "不再弹出输入确认");
      expect(downloadSection).toContain("Ctrl+C");
      expect(downloadSection).toContain(locale === "en" ? "wait for revocation to finish" : "等待撤销完成");
      expect(downloadSection).not.toContain("YES");
      const manual = page.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
      expect(manual).toContain("YES");
      if (os === "win") expect(downloadSection).toContain(locale === "en" ? "double-click" : "双击");
      else {
        expect(downloadSection).toContain("Bash");
        expect(downloadSection).toContain("bash ~/Downloads/");
      }
    }
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
