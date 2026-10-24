# Open Desktop Remote Agent installer (user-level; no system PATH changes).
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$PackageSource = 'open-desktop-remote-agent@0.1.3',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'OpenDesktopRemote'),
  [switch]$InstallOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { $uri = [Uri]::new($Server) } catch { throw 'Invalid server URL.' }
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or
    $uri.Fragment -or $uri.AbsolutePath -ne '/') {
  throw 'Server must be an HTTPS origin.'
}
$Server = $uri.GetLeftPart([UriPartial]::Authority)
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
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri ($base + 'SHASUMS256.txt')).Content
  $pattern = "(?m)^([a-fA-F0-9]{64})\s+(node-v24\.\d+\.\d+-win-$arch\.zip)\s*$"
  $match = [regex]::Match([string]$sums, $pattern)
  if (-not $match.Success) { throw 'Node.js archive checksum not found.' }
  $filename = $match.Groups[2].Value
  $temporary = Join-Path $env:TEMP ('odr-node-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporary | Out-Null
  try {
    $archive = Join-Path $temporary $filename
    Invoke-WebRequest -UseBasicParsing -Uri ($base + $filename) -OutFile $archive
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
if ($expected -and $current -eq $expected -and (Test-Path $cli)) {
  Write-Host "Agent $expected is already installed; keeping the existing device identity."
} else {
  Write-Host "Installing Agent from official npm Registry..."
  & $node $npm install --registry=https://registry.npmjs.org/ --prefix $InstallDir --no-audit --no-fund --package-lock=false $PackageSource
  if ($LASTEXITCODE -ne 0) { throw 'npm installation failed. Check network access to registry.npmjs.org.' }
}
if (-not (Test-Path $cli)) { throw 'Agent CLI was not installed.' }
Write-Host "Agent installed in $InstallDir"
if ($InstallOnly) { return }
Write-Host "Approve your computer at $Server/device when the pairing code appears."
Write-Host 'Keep this window open while you want the computer online.'
& $node $cli agent connect --server $Server
if ($LASTEXITCODE -ne 0) { throw "Agent stopped unexpectedly. Check the error above." }
