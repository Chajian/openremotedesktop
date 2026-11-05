import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { installerPlatforms, type InstallerOS } from "./platforms.js";

export const AGENT_INSTALL_VERSION = "0.1.6";
export type { InstallerOS } from "./platforms.js";
export type DownloadSource = "official" | "npmmirror";
export function installerOsFromQuery(value: unknown): InstallerOS {
  return value === "mac" || value === "linux" ? value : "win";
}
export function supportsAgentSupport(version: string | undefined, automatic = false): boolean {
  if (!version || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  return major > 0 || minor > 1 || (minor === 1 && patch >= (automatic ? 6 : 4));
}
export function downloadSourceFromQuery(value: unknown): DownloadSource {
  return value === "npmmirror" ? "npmmirror" : "official";
}
export const installerRoute = (os: InstallerOS) =>
  installerPlatforms[os].installer.route;

export function installerSource(os: InstallerOS): Buffer {
  const filename = installerPlatforms[os].installer.filename;
  return readFileSync(new URL("../../../../scripts/" + filename, import.meta.url));
}

type SupportInstallerOptions = {invite: string; version: string; acceptSupport?: boolean};
type CommandOptions = {
  url: string;
  origin: string;
  sha256: string;
  support: SupportInstallerOptions | undefined;
  downloadSource: DownloadSource;
};

export function installerInstructions(
  os: InstallerOS, publicUrl: URL,
  support?: SupportInstallerOptions,
  downloadSource: DownloadSource = "official",
) {
  if (downloadSource !== "official" && downloadSource !== "npmmirror") {
    throw new TypeError("Invalid installer download source");
  }
  if (support && (!/^[A-Za-z0-9_-]{32}$/.test(support.invite) ||
      !supportsAgentSupport(support.version, support.acceptSupport))) {
    throw new TypeError("Invalid temporary support installer options");
  }
  const url = new URL(installerRoute(os), publicUrl).toString();
  const origin = publicUrl.origin;
  const sha256 = createHash("sha256").update(installerSource(os)).digest("hex");
  const options = {url, origin, sha256, support, downloadSource};
  const command = os === "win" ? windowsInstallerCommand(options) : posixInstallerCommand(os, options);
  return { url, sha256, command, version: support?.version ?? AGENT_INSTALL_VERSION };
}

// Both shells download and verify the same installer bytes before interpretation.
function windowsInstallerCommand({url, origin, sha256, support, downloadSource}: CommandOptions): string {
  const supportArgs = support
    ? " -SupportInvite '" + support.invite + "' -PackageSource 'open-desktop-remote-agent@" + support.version + "'" : "";
  const launcherArgs = support?.acceptSupport
    ? " -AcceptSupport -InstallDir (Join-Path $env:LOCALAPPDATA 'OpenRemoteSupport')" : "";
  const sourceArgs = downloadSource === "official" ? "" : " -DownloadSource 'npmmirror'";
  return "& { $u='" + url + "'; $f=Join-Path $env:TEMP ('odr-'+[guid]::NewGuid().ToString('N')+'.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $f; if ((Get-FileHash -Algorithm SHA256 $f).Hash.ToLowerInvariant() -ne '" + sha256 + "') { throw 'Installer checksum mismatch' }; & ([scriptblock]::Create([IO.File]::ReadAllText($f))) -Server '" + origin + "'" + supportArgs + launcherArgs + sourceArgs + " } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } }";
}

function posixInstallerCommand(os: Exclude<InstallerOS, "win">, {url, origin, sha256, support, downloadSource}: CommandOptions): string {
  const supportArgs = support
    ? " --support-invite '" + support.invite + "' --package 'open-desktop-remote-agent@" + support.version + "'" : "";
  const launcherArgs = support?.acceptSupport ? " --accept-support" : "";
  const sourceArgs = downloadSource === "official" ? "" : " --download-source 'npmmirror'";
  const checksumCommand = os === "linux" ? "sha256sum -c -" : "shasum -a 256 -c -";
  return "( f=$(mktemp) && trap 'rm -f \"$f\"' EXIT && curl -fsSL '" + url + "' -o \"$f\" && printf '%s  %s\\n' '" + sha256 + "' \"$f\" | " + checksumCommand + " && bash \"$f\" --server '" + origin + "'" + supportArgs + launcherArgs + sourceArgs + "; result=$?; ( exit \"$result\" ) )";
}
