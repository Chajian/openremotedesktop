import {describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {installerInstructions, installerSource, downloadSourceFromQuery} from "./installer.js";
import {loadServerConfig} from "../config.js";

describe("temporary support Windows installer",()=>{
  it("pins the served installer SHA256 and an exact future Agent version",()=>{
    const invite="X".repeat(32);
    const result=installerInstructions("win",new URL("https://remote.example.com"),
      {invite,version:"0.1.4"});
    expect(result.sha256).toBe(createHash("sha256").update(installerSource("win")).digest("hex"));
    expect(result.command).toContain("Get-FileHash -Algorithm SHA256");
    expect(result.command).toContain(" -SupportInvite '"+invite+"'");
    expect(result.command).toContain(" -PackageSource 'open-desktop-remote-agent@0.1.4'");
    expect(result.version).toBe("0.1.4");
    expect(installerInstructions("win",new URL("https://remote.example.com")).version).toBe("0.1.5");
    expect(result.command).not.toContain("agent connect");
    expect(()=>installerInstructions("mac",new URL("https://remote.example.com"),
      {invite,version:"0.1.4"})).toThrow();
    expect(()=>installerInstructions("win",new URL("https://remote.example.com"),
      {invite:"INVALID",version:"0.1.4"})).toThrow();
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
