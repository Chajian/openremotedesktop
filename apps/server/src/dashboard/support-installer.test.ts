import {describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {installerInstructions, installerSource, downloadSourceFromQuery} from "./installer.js";
import {loadServerConfig} from "../config.js";

describe("temporary support installers",()=>{
  it("pins the served installer SHA256 and an exact future Agent version",()=>{
    const invite="X".repeat(32);
    const result=installerInstructions("win",new URL("https://remote.example.com"),
      {invite,version:"0.1.4"});
    expect(result.sha256).toBe(createHash("sha256").update(installerSource("win")).digest("hex"));
    expect(result.command).toContain("Get-FileHash -Algorithm SHA256");
    expect(result.command).toContain(" -SupportInvite '"+invite+"'");
    expect(result.command).toContain(" -PackageSource 'open-desktop-remote-agent@0.1.4'");
    expect(result.version).toBe("0.1.4");
    expect(installerInstructions("win",new URL("https://remote.example.com")).version).toBe("0.1.6");
    expect(result.command).not.toContain("agent connect");
    expect(()=>installerInstructions("win",new URL("https://remote.example.com"),
      {invite:"INVALID",version:"0.1.4"})).toThrow();
  });
  it.each(["mac", "linux"] as const)("passes %s support options with isolated installation and optional launcher acceptance", (os) => {
    const origin = new URL("https://remote.example.com");
    const invite = "X".repeat(32);
    const manual = installerInstructions(os, origin, {invite, version:"0.1.6"}, "npmmirror");
    expect(manual.command).toContain(`--support-invite '${invite}'`);
    expect(manual.command).toContain("--package 'open-desktop-remote-agent@0.1.6'");
    expect(manual.command).toContain("--download-source 'npmmirror'");
    expect(manual.command).not.toContain("--accept-support");
    expect(manual.sha256).toBe(createHash("sha256").update(installerSource(os)).digest("hex"));
    const automatic = installerInstructions(os, origin, {invite, version:"0.1.6", acceptSupport:true});
    expect(automatic.command).toContain("--accept-support");
    expect(automatic.command).not.toContain("-AcceptSupport");
    expect(() => installerInstructions(os, origin, {invite, version:"0.1.5", acceptSupport:true})).toThrow();
    expect(() => installerInstructions(os, origin, {invite:"invalid", version:"0.1.6"})).toThrow();
    expect(() => installerInstructions(os, origin, {invite, version:"0.1.3"})).toThrow();
  });
  it("rejects advertising pre-support Agent versions",()=>{
    expect(()=>loadServerConfig({ODR_SUPPORT_AGENT_VERSION:"0.1.3"})).toThrow();
    expect(()=>loadServerConfig({ODR_SUPPORT_AGENT_VERSION:"0.1.4"})).not.toThrow();
    expect(()=>loadServerConfig({ODR_SUPPORT_AGENT_VERSION:"latest"})).toThrow();
  });

  it("adds only allowlisted download options and retains support consent arguments", () => {
    const origin = new URL("https://remote.example.com");
    const invite = "X".repeat(32);
    const accelerated = installerInstructions("win", origin, {invite, version:"0.1.4"}, "npmmirror");
    expect(accelerated.command).toContain(" -DownloadSource 'npmmirror'");
    expect(accelerated.command).toContain(" -SupportInvite '" + invite + "'");
    expect(accelerated.sha256).toBe(installerInstructions("win", origin).sha256);
    expect(installerInstructions("mac", origin, undefined, "npmmirror").command).toContain(" --download-source 'npmmirror'");
    expect(() => installerInstructions("win", origin, undefined, "evil'; exit" as never)).toThrow();
    expect(downloadSourceFromQuery("npmmirror")).toBe("npmmirror");
    for (const invalid of [undefined, "https://evil.test", ["npmmirror"], "npmmirror;exit"]) {
      expect(downloadSourceFromQuery(invalid)).toBe("official");
    }
  });
});
