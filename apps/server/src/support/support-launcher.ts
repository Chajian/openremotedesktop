import { installerInstructions, type DownloadSource } from "../dashboard/installer.js";
import { windowsCmdLauncher } from "../dashboard/windows-launcher.js";

export function supportsDownloadedLauncher(version: string | undefined): boolean {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  return major > 0 || minor > 1 || (minor === 1 && patch >= 6);
}

export function supportDownloadUrl(origin: URL, invite: string, source: DownloadSource = "official"): string {
  if (!/^[A-Za-z0-9_-]{32}$/.test(invite)) throw new TypeError("Invalid support invite");
  const url = new URL(`/support/invite/${invite}/windows.cmd`, origin);
  if (source === "npmmirror") url.searchParams.set("downloadSource", source);
  return url.toString();
}

export function supportLauncher(origin: URL, invite: string, version: string, source: DownloadSource): string {
  if (!supportsDownloadedLauncher(version)) throw new TypeError("Launcher requires Agent 0.1.6 or newer");
  const installer = installerInstructions("win", origin, {invite, version, acceptSupport: true}, source);
  const preview = new URL(`/api/support/invite/${invite}`, origin).toString();
  return windowsCmdLauncher([
    "Write-Host 'OpenRemote temporary support: starting the downloaded file grants full remote support.' -ForegroundColor Cyan",
    "Write-Host 'Approved AI clients can read and modify files and run programs as your Windows user.'",
    "Write-Host 'Press Ctrl+C to end sharing. Keep this window open during support.'",
    `try { Invoke-RestMethod -Uri '${preview}' -TimeoutSec 30 | Out-Null } catch { throw 'Invitation unavailable, expired or already used. Ask the requester for a new download link.' }`,
    installer.command,
  ].join("\n"));
}
