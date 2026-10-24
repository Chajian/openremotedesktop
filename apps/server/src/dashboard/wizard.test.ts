import { describe, expect, it } from "vitest";
import { renderConnectPage, type WizardOptions } from "./wizard.js";
import { installerInstructions } from "./installer.js";

const url = new URL("https://remote.example.com");
function page(options: Partial<WizardOptions> = {}) {
  return renderConnectPage({ os: "win", step: 1, baseUrl: url, enabled: true, csrf: "csrf123", ...options });
}

describe("standalone Add Device wizard", () => {
  it("retains the original full-screen wizard shell rather than adding Dashboard navigation", () => {
    const html = page();
    expect(html).toContain('class="wz"');
    expect(html).toContain('class="wz-top"');
    expect(html).toContain('class="steps"');
    expect(html).toContain('class="footer"');
    expect(html).toContain("选择系统");
    expect(html).toContain("运行命令");
    expect(html).toContain("输入配对码");
    expect(html).toContain("完成");
    expect(html).toContain("/dashboard/connect?step=2&os=mac");
    expect(html).toContain("/dashboard/connect?step=2&os=linux");
    expect(html).not.toContain("侧边栏");
    expect(html).not.toContain("Team & Sharing");
  });

  for (const [os, endpoint] of [["win", "/install/windows.ps1"], ["mac", "/install/macos.sh"]] as const) {
    it("uses pinned " + os + " installer in step 2 with a real copy target", () => {
      const html = page({ os, step: 2 });
      const command = installerInstructions(os, url);
      expect(html).toContain(endpoint);
      expect(html).toContain("Agent 0.1.2");
      expect(html).toContain(command.sha256);
      expect(html).toContain('data-copy="install-command"');
      expect(html).toContain('id="install-command"');
      expect(html).toContain("/dashboard/connect?step=3&os=" + os);
      expect(html).not.toContain("node_modules");
    });
  }

  it("keeps Windows/macOS installation closed until published, without hiding Linux documentation", () => {
    const blocked = page({ step: 2, enabled: false });
    expect(blocked).toContain("一键安装尚未启用");
    expect(blocked).not.toContain('data-copy="install-command"');
    const linux = page({ os: "linux", step: 2, enabled: false });
    expect(linux).toContain("Agent 文档");
    expect(linux).not.toContain("一键安装尚未启用");
  });

  it("prefills only a valid one-time pairing code and escapes dynamic form fields", () => {
    const html = page({ step: 3, code: "K7QM-4WXP", csrf: "<untrusted>" });
    expect(html).toContain('value="K7QM-4WXP"');
    expect(html).toContain('name="csrf" value="&lt;untrusted&gt;"');
    expect(html).toContain('form="pairing-form"');
    expect(html).toContain("确认批准这台设备");
    expect(html).not.toContain('value="<untrusted>"');
    const invalid = page({ step: 3, code: '<img src=x onerror=alert(1)>' });
    expect(invalid).not.toContain('onerror=alert(1)');
    expect(invalid).toContain('name="userCode"');
  });
});
