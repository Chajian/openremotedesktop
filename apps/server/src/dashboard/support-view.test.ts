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
