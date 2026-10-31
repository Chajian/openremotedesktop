/** Foreground launcher. Its embedded PowerShell is readable, never an encoded command. */
export function windowsCmdLauncher(command: string): string {
  const marker = "### ODR_POWERSHELL ###";
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'title OpenRemote - Temporary Support',
    'set "ODR_SUPPORT_LAUNCHER=%~f0"',
    `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:ODR_SUPPORT_LAUNCHER); & ([scriptblock]::Create($s.Substring($s.LastIndexOf('${marker}')+${marker.length})))"`,
    'set "ODR_SUPPORT_EXIT=%ERRORLEVEL%"',
    "echo.",
    "pause",
    "exit /b %ODR_SUPPORT_EXIT%",
    marker,
    "$ErrorActionPreference = 'Stop'",
    "try {",
    command,
    "  exit 0",
    "} catch {",
    "  Write-Host ('OpenRemote: ' + $_.Exception.Message) -ForegroundColor Red",
    "  exit 1",
    "}",
    "",
  ].join("\n").replace(/\r?\n/g, "\r\n");
}
