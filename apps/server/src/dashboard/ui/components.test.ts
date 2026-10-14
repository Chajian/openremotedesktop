import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { html } from "./html.js";
import { appDocument, soloDocument, hiddenInput, codeBlock, pageHead, callout, emptyState, accountLabel, type ShellContext } from "./components.js";
import { STYLES } from "./styles.js";
import { icon, type IconName } from "./icons.js";

const ctx: ShellContext = {
  locale: "en", account: { id: "owner", authSource: "github", githubLogin: "octo-cat", createdAt: 1 },
  nav: "devices", path: "/dashboard/devices", csrf: "test-csrf", publicBaseUrl: new URL("https://remote.example.com"),
};
const body = html`<h1>Devices</h1>`;

describe("Bridge page shell", () => {
  it("renders locale, viewport and the active desktop and mobile destinations", () => {
    const page = appDocument({ ctx: { ...ctx, locale: "zh-CN" }, title: "设备", body, enhance: false });
    expect(page).toContain('<html lang="zh-CN">');
    expect(page).toContain('<meta name="viewport"');
    for (const name of ["tabs", "mtab"]) {
      const nav = new RegExp(`<nav class="${name}"[^>]*>([\\s\\S]*?)</nav>`).exec(page)?.[1];
      expect(nav).toMatch(/<a class="on" href="\/dashboard\/devices"/);
      expect(nav).not.toMatch(/<a class="on" href="\/dashboard\/mcp"/);
    }
    expect(page).toMatch(/<a class="avatar"[^>]*>o<\/a>/);
  });
  it("provides a signed-in logout form and safely encoded language links", () => {
    const page = appDocument({ ctx, title: "Devices", body, enhance: false });
    expect(page).toContain('<form method="post" action="/dashboard/logout">');
    expect(page).toContain('<input type="hidden" name="csrf" value="test-csrf">');
    expect(page).toContain('/dashboard/lang?to=zh-CN&amp;returnTo=%2Fdashboard%2Fdevices');
    expect(page).not.toContain('/dashboard/lang?to=en');
    expect(page).not.toContain('<script');
  });
  it("adds refresh and enhancement only when requested and escapes the title", () => {
    const page = appDocument({ ctx, title: '<script>x</script>', body, refreshSeconds: 3, enhance: true, fab: true });
    expect(page).toContain('<meta http-equiv="refresh" content="3">');
    expect(page).toContain('<script src="/dashboard/assets/ui.js" defer></script>');
    expect(page).toContain('mfab');
    expect(page).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
  it("keeps standalone documents compatible with the private-page CSP", () => {
    const page = soloDocument({ locale: "en", title: "Sign in", body, langSwitchPath: "/dashboard/login" });
    expect(page).toContain('class="solo"');
    expect(page).toContain('class="solo-brand"');
    expect(page).not.toMatch(/<(?:script|link|img)\b/i);
    expect(page).not.toContain('class="mtab"');
  });
  it("formats account labels without inventing a GitHub identity", () => {
    expect(accountLabel("en", ctx.account)).toBe("@octo-cat");
    expect(accountLabel("zh-CN", null)).toBe("实例 Owner");
  });
});

describe("Bridge components", () => {
  it("preserves the hidden-input extraction contract while escaping values", () => {
    expect(hiddenInput("csrf", 'a"b').value).toBe('<input type="hidden" name="csrf" value="a&quot;b">');
  });
  it("escapes command lines, labels and copy payloads", () => {
    const block = codeBlock({ locale: "en", label: "<label>", prompt: "PS>", lines: ["# comment", '<script>alert("x")</script>'], copyText: 'a"b' }).value;
    expect(block).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(block).toContain('data-copy="a&quot;b"');
    expect(block).toContain('data-copied-label="Copied"');
    expect(block).toContain('class="c"># comment');
    expect(block).not.toContain('<script');
  });
  it("escapes text in headers, notices and empty states", () => {
    expect(pageHead({ title: "<x>", lead: "a&b" }).value).toContain('&lt;x&gt;');
    expect(callout("err", "<x>", "<body>").value).toContain('&lt;body&gt;');
    expect(emptyState({ icon: "monitor", title: "<x>", body: "<body>" }).value).toContain('&lt;body&gt;');
  });
  it("ports the approved CSS without the prototype-only rules", () => {
    const source = readFileSync(new URL("../__fixtures__/b.css", import.meta.url), "utf8");
    const expected = source.split(/\r?\n/).filter(line => !/^\s*\.proto\b/.test(line) && !/^\s*\.clean \.wz-foot\b/.test(line)).join("\n");
    expect(STYLES.startsWith(expected)).toBe(true);
    expect(STYLES).not.toMatch(/\.proto\b|\.clean \.wz-foot/);
    expect(STYLES).toContain('.sr-only');
    expect(STYLES).toContain('.lang-switch');
  });
  it("keeps muted bilingual captions legible on cobalt primary buttons", () => {
    // Browser QA measured rgb(74,81,97) on rgb(51,85,255), failing AA text contrast.
    // The more-specific rule must override the generic .muted text color.
    expect(STYLES).toMatch(/\.btn-primary\s+\.muted\s*\{\s*color:\s*#fff\s*;?\s*\}/i);
  });
  it("ports every approved SVG path and stroke attribute exactly", () => {
    const source = readFileSync(new URL("../__fixtures__/icons.js", import.meta.url), "utf8");
    const sandbox = { window: {} as { icon?: (name: string, size: number) => string } };
    runInNewContext(source, sandbox);
    const names = [...source.matchAll(/^    (\w+):/gm)].map(match => match[1]!);
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) expect(icon(name as IconName, 20).value).toBe(sandbox.window.icon!(name, 20).replace('class="i "', 'class="i"'));
  });
});
