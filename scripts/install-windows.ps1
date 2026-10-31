# Open Desktop Remote Agent installer (user-level; no system PATH changes).
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$PackageSource = 'open-desktop-remote-agent@0.1.6',
  [ValidateSet('official', 'npmmirror')][string]$DownloadSource = 'official',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'OpenDesktopRemote'),
  [switch]$InstallOnly,
  [string]$SupportInvite = '',
  [switch]$AcceptSupport
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { $uri = [Uri]::new($Server) } catch { throw 'Invalid server URL.' }
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or
    $uri.Fragment -or $uri.AbsolutePath -ne '/') {
  throw 'Server must be an HTTPS origin.'
}
$Server = $uri.GetLeftPart([UriPartial]::Authority)
if ($DownloadSource -eq 'npmmirror' -and $PackageSource -notmatch '^open-desktop-remote-agent@[0-9]+[.][0-9]+[.][0-9]+$') {
  throw 'npmmirror requires an exact npm Agent version.'
}
if ($SupportInvite -and $SupportInvite -notmatch '^[A-Za-z0-9_-]{32}$') { throw 'Invalid support invite.' }
if ($AcceptSupport -and -not $SupportInvite) { throw 'AcceptSupport requires a support invitation.' }
if ($SupportInvite) {
  if ($PackageSource -notmatch '^open-desktop-remote-agent@([0-9]+[.][0-9]+[.][0-9]+)$') {
    throw 'Support requires an exact, verified npm Agent version.'
  }
  if ([Version]$Matches[1] -lt [Version]'0.1.4') {
    throw 'This Agent version does not support temporary sessions.'
  }
  if ($AcceptSupport -and [Version]$Matches[1] -lt [Version]'0.1.6') {
    throw 'Downloaded support launchers require Agent 0.1.6 or newer.'
  }
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$runtime = Join-Path $InstallDir 'runtime'
$node = Join-Path $runtime 'node.exe'
$installedVersion = if (Test-Path $node) { & $node --version } else { '' }
if ($installedVersion -notmatch '^v24\.') {
  $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($cpu) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported architecture: $cpu" }
  }
  $base = 'https://nodejs.org/dist/latest-v24.x/'
  Write-Host 'Downloading Node.js 24 from nodejs.org...'
  $sums = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri ($base + 'SHASUMS256.txt')).Content
  $pattern = "(?m)^([a-fA-F0-9]{64})\s+(node-v24\.\d+\.\d+-win-$arch\.zip)\s*$"
  $match = [regex]::Match([string]$sums, $pattern)
  if (-not $match.Success) { throw 'Node.js archive checksum not found.' }
  $filename = $match.Groups[2].Value
  $temporary = Join-Path $env:TEMP ('odr-node-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporary | Out-Null
  try {
    $archive = Join-Path $temporary $filename
    if ($DownloadSource -eq 'npmmirror') {
      $nodeVersion = [regex]::Match($filename, '^node-(v24\.\d+\.\d+)-').Groups[1].Value
      try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "https://npmmirror.com/mirrors/node/$nodeVersion/$filename" -OutFile $archive
      } catch {
        Write-Host 'Mirror download unavailable; downloading Node.js from nodejs.org.'
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri ($base + $filename) -OutFile $archive
      }
    } else {
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri ($base + $filename) -OutFile $archive
    }
    if ((Get-FileHash -Algorithm SHA256 $archive).Hash -ne $match.Groups[1].Value) {
      throw 'Node.js archive checksum mismatch.'
    }
    Expand-Archive -Path $archive -DestinationPath $temporary
    if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
    Move-Item (Join-Path $temporary ($filename -replace '\.zip$', '')) $runtime
  } finally {
    Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue
  }
}
$npm = Join-Path $runtime 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npm)) { throw 'npm missing from Node.js distribution.' }
$cli = Join-Path $InstallDir 'node_modules\open-desktop-remote-agent\dist\cli.mjs'
$manifest = Join-Path $InstallDir 'node_modules\open-desktop-remote-agent\package.json'
$expected = if ($PackageSource -match '^open-desktop-remote-agent@(\d+\.\d+\.\d+)$') { $Matches[1] } else { '' }
$current = if (Test-Path $manifest) { (Get-Content $manifest -Raw | ConvertFrom-Json).version } else { '' }
$installerOriginalPath = $env:PATH
$packageTemporary = $null
try {
  # npm lifecycle scripts and Agent children must find the private Node runtime.
  $env:PATH = $runtime + [IO.Path]::PathSeparator + $installerOriginalPath
  if ($expected -and $current -eq $expected -and (Test-Path $cli)) {
    Write-Host "Agent $expected is already installed; keeping the existing device identity."
  } else {
    $registry = 'https://registry.npmjs.org/'
    $installSource = $PackageSource
    if ($DownloadSource -eq 'npmmirror') {
      $metadata = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "https://registry.npmjs.org/open-desktop-remote-agent/$expected").Content | ConvertFrom-Json
      $officialTarball = "https://registry.npmjs.org/open-desktop-remote-agent/-/open-desktop-remote-agent-$expected.tgz"
      if ($metadata.name -cne 'open-desktop-remote-agent' -or $metadata.version -cne $expected -or
          $metadata.dist.tarball -cne $officialTarball -or $metadata.dist.integrity -cnotmatch '^sha512-[A-Za-z0-9+/]{86}==$') {
        throw 'Official Agent metadata is invalid or lacks SHA512 integrity.'
      }
      $packageTemporary = Join-Path $env:TEMP ('odr-package-' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $packageTemporary | Out-Null
      $installSource = Join-Path $packageTemporary 'agent.tgz'
      $registry = 'https://registry.npmmirror.com/'
      try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri "https://registry.npmmirror.com/open-desktop-remote-agent/-/open-desktop-remote-agent-$expected.tgz" -OutFile $installSource
      } catch {
        Write-Host 'Mirror download unavailable; downloading Agent from official npm Registry.'
        $registry = 'https://registry.npmjs.org/'
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $officialTarball -OutFile $installSource
      }
      $sha512 = [Security.Cryptography.SHA512]::Create()
      $stream = [IO.File]::OpenRead($installSource)
      try { $actualIntegrity = 'sha512-' + [Convert]::ToBase64String($sha512.ComputeHash($stream)) }
      finally { $stream.Dispose(); $sha512.Dispose() }
      if ($actualIntegrity -cne $metadata.dist.integrity) { throw 'Agent archive integrity mismatch.' }
    }
    Write-Host "Installing Agent using $registry"
    # Never retry npm: a failed install may already have run lifecycle scripts.
    & $node $npm install "--registry=$registry" --prefix $InstallDir --no-audit --no-fund --package-lock=false $installSource
    if ($LASTEXITCODE -ne 0) { throw 'npm installation failed. Check network access; installation was not retried.' }
  }
  if (-not (Test-Path $cli)) { throw 'Agent CLI was not installed.' }
  Write-Host "Agent installed in $InstallDir"
  if ($InstallOnly) { return }
  if ($SupportInvite) {
    Write-Host 'Temporary support mode. Keep this window open; press Ctrl+C to end sharing.'
    $supportArguments = @('agent', 'support', '--server', $Server, '--invite', $SupportInvite)
    if ($AcceptSupport) { $supportArguments += '--accept-support' }
    & $node $cli @supportArguments
  } else {
    Write-Host "Approve your computer at $Server/device when the pairing code appears."
    Write-Host 'Keep this window open while you want the computer online.'
    & $node $cli agent connect --server $Server
  }
  if ($LASTEXITCODE -ne 0) { throw "Agent stopped unexpectedly. Check the error above." }
} finally {
  $env:PATH = $installerOriginalPath
  if ($packageTemporary) { Remove-Item -LiteralPath $packageTemporary -Recurse -Force -ErrorAction SilentlyContinue }
}
