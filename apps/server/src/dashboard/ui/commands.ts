export type AgentOs = "win" | "mac" | "linux";
export const AGENT_REPO_URL = "https://github.com/Chajian/openremotedesktop.git";
export function agentOsFromPlatform(platform: string | null): AgentOs {
  return platform === "win32" ? "win" : platform === "darwin" ? "mac" : "linux";
}
/** Single-line commands only: PowerShell does not accept the README's trailing-backslash continuation. */
export function agentCommands(os: AgentOs, publicBaseUrl: URL): { shell: "PowerShell" | "Terminal"; install: string[]; connect: string } {
  return {
    shell: os === "win" ? "PowerShell" : "Terminal",
    install: [`git clone ${AGENT_REPO_URL}`, "cd openremotedesktop", "corepack enable", "pnpm --filter @open-desktop-remote/agent... install --frozen-lockfile"],
    connect: `pnpm --filter @open-desktop-remote/agent start -- agent connect --server ${publicBaseUrl.origin}`,
  };
}
