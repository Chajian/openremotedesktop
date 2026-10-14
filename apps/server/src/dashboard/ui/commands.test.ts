import { expect, it } from "vitest";
import { agentCommands, agentOsFromPlatform } from "./commands.js";
it.each(["win", "mac", "linux"] as const)("uses the instance origin and single-line commands on %s", (os) => {
  const commands = agentCommands(os, new URL("https://remote.example.com/"));
  expect(commands.install[0]).toBe("git clone https://github.com/Chajian/openremotedesktop.git");
  expect(commands.install[1]).toBe("cd openremotedesktop");
  expect(commands.connect).toMatch(/--server https:\/\/remote\.example\.com$/);
  for (const line of [...commands.install, commands.connect]) {
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).not.toMatch(/\\$/);
  }
  expect(commands.shell).toBe(os === "win" ? "PowerShell" : "Terminal");
});
it("maps platform values to agent operating systems", () => {
  expect(agentOsFromPlatform("darwin")).toBe("mac");
  expect(agentOsFromPlatform("win32")).toBe("win");
  expect(agentOsFromPlatform(null)).toBe("linux");
});
