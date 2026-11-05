import { installerInstructions, supportsAgentSupport, type DownloadSource, type InstallerOS } from "../dashboard/installer.js";
import { windowsCmdLauncher } from "../dashboard/windows-launcher.js";
import { installerPlatforms } from "../dashboard/platforms.js";

export function supportsDownloadedLauncher(version: string | undefined): boolean {
  return supportsAgentSupport(version, true);
}

export function supportDownloadUrl(origin: URL, invite: string, source: DownloadSource = "official", os: InstallerOS = "win"): string {
  if (!/^[A-Za-z0-9_-]{32}$/.test(invite)) throw new TypeError("Invalid support invite");
  const url = new URL(`/support/invite/${invite}/${installerPlatforms[os].support.route}`, origin);
  if (source === "npmmirror") url.searchParams.set("downloadSource", source);
  return url.toString();
}

export function supportLauncher(origin: URL, invite: string, version: string, source: DownloadSource, os: InstallerOS = "win"): string {
  if (!supportsDownloadedLauncher(version)) throw new TypeError("Launcher requires Agent 0.1.6 or newer");
  const installer = installerInstructions(os, origin, {invite, version, acceptSupport: true}, source);
  const preview = new URL(`/api/support/invite/${invite}`, origin).toString();
  if (os !== "win") {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' 'OpenRemote temporary support: running this file grants full remote support.'",
      "printf '%s\\n' 'Approved AI clients can read and modify files and run programs as your current OS user.'",
      "printf '%s\\n' 'Only continue if you trust the requester. Keep this terminal open; press Ctrl+C and wait for revocation.'",
      `curl --fail --silent --show-error --connect-timeout 15 --max-time 30 '${preview}' -o /dev/null || { printf '%s\\n' 'Invitation unavailable, expired or already used. Ask the requester for a new link.' >&2; exit 1; }`,
      installer.command,
      "",
    ].join("\n");
  }
  return windowsCmdLauncher([
    "Write-Host 'OpenRemote temporary support: starting the downloaded file grants full remote support.' -ForegroundColor Cyan",
    "Write-Host 'Approved AI clients can read and modify files and run programs as your Windows user.'",
    "Write-Host 'Press Ctrl+C to end sharing. Keep this window open during support.'",
    `try { Invoke-RestMethod -Uri '${preview}' -TimeoutSec 30 | Out-Null } catch { throw 'Invitation unavailable, expired or already used. Ask the requester for a new download link.' }`,
    installer.command,
  ].join("\n"));
}
