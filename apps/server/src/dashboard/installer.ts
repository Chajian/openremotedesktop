import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const AGENT_INSTALL_VERSION = "0.1.6";
export type InstallerOS = "win" | "mac";
export type DownloadSource = "official" | "npmmirror";
export function downloadSourceFromQuery(value: unknown): DownloadSource {
  return value === "npmmirror" ? "npmmirror" : "official";
}
export const installerRoute = (os: InstallerOS) =>
  os === "win" ? "/install/windows.ps1" : "/install/macos.sh";

export function installerSource(os: InstallerOS): Buffer {
  const filename = os === "win" ? "install-windows.ps1" : "install-macos.sh";
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
  if (support && (os !== "win" || !/^[A-Za-z0-9_-]{32}$/.test(support.invite) ||
      !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(support.version))) {
    throw new TypeError("Invalid temporary support installer options");
  }
  const url = new URL(installerRoute(os), publicUrl).toString();
  const origin = publicUrl.origin;
  const sha256 = createHash("sha256").update(installerSource(os)).digest("hex");
  const supportArgs = support ? " -SupportInvite '" + support.invite + "' -PackageSource 'open-desktop-remote-agent@" + support.version + "'" : "";
  const launcherArgs = support?.acceptSupport
    ? " -AcceptSupport -InstallDir (Join-Path $env:LOCALAPPDATA 'OpenRemoteSupport')" : "";
  const sourceArgs = downloadSource === "official" ? "" : os === "win"
    ? " -DownloadSource 'npmmirror'" : " --download-source 'npmmirror'";
  // Download then verify bytes before interpreting a remote script.
  const command = os === "win"
    ? "& { $u='" + url + "'; $f=Join-Path $env:TEMP ('odr-'+[guid]::NewGuid().ToString('N')+'.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $f; if ((Get-FileHash -Algorithm SHA256 $f).Hash.ToLowerInvariant() -ne '" + sha256 + "') { throw 'Installer checksum mismatch' }; & ([scriptblock]::Create([IO.File]::ReadAllText($f))) -Server '" + origin + "'" + supportArgs + launcherArgs + sourceArgs + " } finally { Remove-Item $f -Force -ErrorAction SilentlyContinue } }"
    : "( f=$(mktemp) && curl -fsSL '" + url + "' -o \"$f\" && printf '%s  %s\\n' '" + sha256 + "' \"$f\" | shasum -a 256 -c - && bash \"$f\" --server '" + origin + "'" + sourceArgs + "; result=$?; rm -f \"$f\"; ( exit \"$result\" ) )";
  return { url, sha256, command, version: support?.version ?? AGENT_INSTALL_VERSION };
}
