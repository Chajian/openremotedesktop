import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const AGENT_INSTALL_VERSION = "0.1.6";
export type InstallerOS = "win" | "mac" | "linux";
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
  os === "win" ? "/install/windows.ps1" : os === "mac" ? "/install/macos.sh" : "/install/linux.sh";

export function installerSource(os: InstallerOS): Buffer {
  const filename = os === "win" ? "install-windows.ps1" : os === "mac" ? "install-macos.sh" : "install-linux.sh";
  return readFileSync(new URL("../../../../scripts/" + filename, import.meta.url));
}

export function installerInstructions(
  os: InstallerOS, publicUrl: URL,
  support?: {invite: string; version: string; acceptSupport?: boolean},
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
  const supportArgs = !support ? "" : os === "win"
    ? " -SupportInvite '" + support.invite + "' -PackageSource 'open-desktop-remote-agent@" + support.version + "'"
    : " --support-invite '" + support.invite + "' --package 'open-desktop-remote-agent@" + support.version + "'";
  const launcherArgs = support?.acceptSupport
    ? os === "win" ? " -AcceptSupport -InstallDir (Join-Path $env:LOCALAPPDATA 'OpenRemoteSupport')" : " --accept-support"
    : "";
  const sourceArgs = downloadSource === "official" ? "" : os === "win"
    ? " -DownloadSource 'npmmirror'" : " --download-source 'npmmirror'";
  // Download then verify bytes before interpreting a remote script.
  const checksumCommand = os === "linux" ? "sha256sum -c -" : "shasum -a 256 -c -";
  const command = os === "win"
    ? "& { $u='" + url + "'; $f=Join-Path $env:TEMP ('odr-'+[guid]::NewGuid().ToString('N')+'.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $f; if ((Get-FileHash -Algorithm SHA256 $f).Hash.ToLowerInvariant() -ne '" + sha256 + "') { throw 'Installer checksum mismatch' }; & ([scriptblock]::Create([IO.File]::ReadAllText($f))) -Server '" + origin + "'" + supportArgs + launcherArgs + sourceArgs + " } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } }"
    : "( f=$(mktemp) && trap 'rm -f \"$f\"' EXIT && curl -fsSL '" + url + "' -o \"$f\" && printf '%s  %s\\n' '" + sha256 + "' \"$f\" | " + checksumCommand + " && bash \"$f\" --server '" + origin + "'" + supportArgs + launcherArgs + sourceArgs + "; result=$?; ( exit \"$result\" ) )";
  return { url, sha256, command, version: support?.version ?? AGENT_INSTALL_VERSION };
}
