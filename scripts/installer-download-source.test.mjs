import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const payload = Buffer.from('verified fixture package bytes');
const integrity = 'sha512-' + createHash('sha512').update(payload).digest('base64');
const nodeArchive = `node-v24.9.0-${windows ? 'win' : 'darwin'}-${process.arch}.${windows ? 'zip' : 'tar.gz'}`;
const nodeSums = createHash('sha256').update(payload).digest('hex') + '  ' + nodeArchive + '\n';

function fixture(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'odr-download-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const install = join(directory, 'install with spaces');
  const runtime = join(install, 'runtime');
  const bin = windows ? runtime : join(runtime, 'bin');
  const npm = join(runtime, windows ? 'node_modules/npm/bin' : 'lib/node_modules/npm/bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(npm, { recursive: true });
  copyFileSync(process.execPath, join(bin, windows ? 'node.exe' : 'node'));
  writeFileSync(join(directory, 'payload'), payload);
  const metadata = { name: 'open-desktop-remote-agent', version: '0.1.4', dist: {
    integrity, tarball: 'https://registry.npmjs.org/open-desktop-remote-agent/-/open-desktop-remote-agent-0.1.4.tgz',
  } };
  if (mode === 'bad-name') metadata.name = 'other-package';
  if (mode === 'bad-version') metadata.version = '0.1.3';
  if (mode === 'bad-integrity') metadata.dist.integrity = 'sha1-not-authoritative';
  if (mode === 'bad-tarball') metadata.dist.tarball = 'https://untrusted.example.test/package.tgz';
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata));
  writeFileSync(join(directory, 'SHASUMS256.txt'), nodeSums);
  writeFileSync(join(npm, 'npm-cli.js'), `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    fs.appendFileSync(path.join(process.env.ODR_DOWNLOAD_TEST, 'npm.jsonl'), JSON.stringify(args) + '\\n');
    if (process.env.ODR_DOWNLOAD_MODE === 'npm-failure') process.exit(17);
    const installed = path.join(args[args.indexOf('--prefix') + 1], 'node_modules/open-desktop-remote-agent/dist');
    fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, 'cli.mjs'), '');
  `);
  if (mode.startsWith('node-')) renameSync(runtime, join(directory, 'runtime-seed'));
  const env = { ...process.env, ODR_DOWNLOAD_TEST: directory, ODR_DOWNLOAD_MODE: mode };
  let command, args;
  if (windows) {
    const wrapper = join(directory, 'invoke.ps1');
    writeFileSync(wrapper, `
param([string]$Installer, [string]$Destination, [string]$Source, [string]$Package)
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile, [int]$TimeoutSec)
  if ($TimeoutSec -le 0) { throw 'Unbounded request' }
  Add-Content (Join-Path $env:ODR_DOWNLOAD_TEST 'requests.txt') $Uri
  if ($Uri -eq 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt') {
    $content = Get-Content (Join-Path $env:ODR_DOWNLOAD_TEST 'SHASUMS256.txt') -Raw
  } elseif ($Uri -eq 'https://npmmirror.com/mirrors/node/v24.9.0/${nodeArchive}' -or $Uri -eq 'https://nodejs.org/dist/latest-v24.x/${nodeArchive}') {
    if ($Uri.Contains('npmmirror') -and $env:ODR_DOWNLOAD_MODE -eq 'node-missing') { throw 'Mirror unavailable' }
    if ($env:ODR_DOWNLOAD_MODE -eq 'node-corrupt') { [IO.File]::WriteAllText($OutFile, 'corrupt') }
    else { Copy-Item (Join-Path $env:ODR_DOWNLOAD_TEST 'payload') $OutFile }
    return
  } elseif ($Uri -eq 'https://registry.npmjs.org/open-desktop-remote-agent/0.1.4') {
    if ($env:ODR_DOWNLOAD_MODE -eq 'metadata-unavailable') { throw 'Metadata unavailable' }
    $content = Get-Content (Join-Path $env:ODR_DOWNLOAD_TEST 'metadata.json') -Raw
  } elseif ($Uri -eq 'https://registry.npmmirror.com/open-desktop-remote-agent/-/open-desktop-remote-agent-0.1.4.tgz' -or $Uri -eq 'https://registry.npmjs.org/open-desktop-remote-agent/-/open-desktop-remote-agent-0.1.4.tgz') {
    if ($Uri.Contains('npmmirror') -and $env:ODR_DOWNLOAD_MODE -eq 'mirror-missing') { throw 'Mirror unavailable' }
    if ($env:ODR_DOWNLOAD_MODE -eq 'corrupt') { [IO.File]::WriteAllText($OutFile, 'corrupt') }
    else { Copy-Item (Join-Path $env:ODR_DOWNLOAD_TEST 'payload') $OutFile }
    return
  } else { throw "Unexpected URL: $Uri" }
  if ($OutFile) { [IO.File]::WriteAllText($OutFile, $content) } else { return @{ Content = $content } }
}
function Expand-Archive {
  param([string]$Path, [string]$DestinationPath)
  Set-Content (Join-Path $env:ODR_DOWNLOAD_TEST 'extracted') 'yes'
  Copy-Item (Join-Path $env:ODR_DOWNLOAD_TEST 'runtime-seed') (Join-Path $DestinationPath '${nodeArchive.replace(/\.zip$/, '')}') -Recurse
}
$originalPath = $env:PATH
$failure = $null
try { & $Installer -Server https://remote.example.test -InstallDir $Destination -DownloadSource $Source -PackageSource $Package -InstallOnly }
catch { $failure = $_ }
if ($env:PATH -cne $originalPath) { throw 'Caller PATH was changed' }
if ($failure) { Write-Error $failure; exit 1 }
`);
    command = 'pwsh';
    args = ['-NoProfile', '-File', wrapper, '-Installer', join(root, 'scripts/install-windows.ps1'), '-Destination', install];
  } else {
    const tools = join(directory, 'tools');
    mkdirSync(tools);
    // Minimal Linux images may omit Perl's shasum. Delegate to the real system
    // SHA256 verifier; macOS and CI hosts with shasum exercise it directly.
    if (spawnSync('shasum', ['--version']).error?.code === 'ENOENT') {
      assert.equal(spawnSync('sha256sum', ['--version']).status, 0, 'A real SHA256 verifier is required');
      writeFileSync(join(tools, 'shasum'), '#!/bin/sh\nexec sha256sum -c -\n', { mode: 0o755 });
    }
    writeFileSync(join(tools, 'curl'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), dir = process.env.ODR_DOWNLOAD_TEST, mode = process.env.ODR_DOWNLOAD_MODE;
if (!args.includes('--max-time') || !args.includes('--connect-timeout')) process.exit(9);
const url = args.find(arg => arg.startsWith('https://'));
fs.appendFileSync(path.join(dir, 'requests.txt'), url + '\\n');
let bytes;
if (url === 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt') {
  bytes = fs.readFileSync(path.join(dir, 'SHASUMS256.txt'));
} else if (['https://npmmirror.com/mirrors/node/v24.9.0/${nodeArchive}', 'https://nodejs.org/dist/latest-v24.x/${nodeArchive}'].includes(url)) {
  if (url.includes('npmmirror') && mode === 'node-missing') process.exit(22);
  bytes = mode === 'node-corrupt' ? Buffer.from('corrupt') : fs.readFileSync(path.join(dir, 'payload'));
} else if (url === 'https://registry.npmjs.org/open-desktop-remote-agent/0.1.4') {
  if (mode === 'metadata-unavailable') process.exit(22);
  bytes = fs.readFileSync(path.join(dir, 'metadata.json'));
} else if (['https://registry.npmmirror.com/open-desktop-remote-agent/-/open-desktop-remote-agent-0.1.4.tgz', 'https://registry.npmjs.org/open-desktop-remote-agent/-/open-desktop-remote-agent-0.1.4.tgz'].includes(url)) {
  if (url.includes('npmmirror') && mode === 'mirror-missing') process.exit(22);
  bytes = mode === 'corrupt' ? Buffer.from('corrupt') : fs.readFileSync(path.join(dir, 'payload'));
} else { console.error('Unexpected URL: ' + url); process.exit(8); }
if (args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], bytes); else process.stdout.write(bytes);
`, { mode: 0o755 });
    writeFileSync(join(tools, 'tar'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), dir = process.env.ODR_DOWNLOAD_TEST;
fs.writeFileSync(path.join(dir, 'extracted'), 'yes');
fs.cpSync(path.join(dir, 'runtime-seed'), path.join(args[args.indexOf('-C') + 1], '${nodeArchive.replace(/\.tar\.gz$/, '')}'), { recursive: true });
`, { mode: 0o755 });
    env.PATH = tools + ':' + env.PATH;
    command = '/bin/bash';
    args = [join(root, 'scripts/install-macos.sh'), '--server', 'https://remote.example.test', '--install-dir', install, '--install-only'];
  }
  return { directory, run(source = 'npmmirror', packageSource = 'open-desktop-remote-agent@0.1.4') {
    const result = spawnSync(command, [...args, ...(windows ? ['-Source', source, '-Package', packageSource] : ['--download-source', source, '--package', packageSource])], { env, encoding: 'utf8', timeout: 60_000 });
    const calls = existsSync(join(directory, 'npm.jsonl')) ? readFileSync(join(directory, 'npm.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
    const requests = existsSync(join(directory, 'requests.txt')) ? readFileSync(join(directory, 'requests.txt'), 'utf8') : '';
    return { ...result, calls, requests };
  } };
}

for (const mode of ['mirror', 'mirror-missing', 'corrupt', 'metadata-unavailable', 'bad-name', 'bad-version', 'bad-integrity', 'bad-tarball', 'npm-failure']) {
  test(`verified download: ${mode}`, t => {
    const f = fixture(t, mode), result = f.run();
    const installs = ['mirror', 'mirror-missing', 'npm-failure'].includes(mode);
    if (['mirror', 'mirror-missing'].includes(mode)) assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.calls.length, installs ? 1 : 0, 'npm must only run once after verified download');
    assert.match(result.requests, /https:\/\/registry\.npmjs\.org\/open-desktop-remote-agent\/0\.1\.4/);
    if (installs) {
      assert(result.calls[0].includes(`--registry=https://registry.${mode === 'mirror-missing' ? 'npmjs.org' : 'npmmirror.com'}/`));
      const tarball = result.calls[0].at(-1);
      assert(tarball.endsWith('.tgz'), 'npm receives verified local tarball');
      assert(!existsSync(tarball), 'temporary tarball cleaned');
    }
    if (mode === 'corrupt') assert(!result.requests.includes('https://registry.npmjs.org/open-desktop-remote-agent/-/'), 'integrity mismatch must not downgrade');
    if (mode === 'mirror-missing') assert(result.requests.includes('https://registry.npmjs.org/open-desktop-remote-agent/-/'));
  });
}

for (const mode of ['node-mirror', 'node-missing', 'node-corrupt']) {
  test(`Node archive: ${mode}`, t => {
    const f = fixture(t, mode), result = f.run();
    assert(result.requests.includes('https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt'));
    assert(result.requests.includes(`https://npmmirror.com/mirrors/node/v24.9.0/${nodeArchive}`), result.stdout + result.stderr);
    if (mode === 'node-corrupt') {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /checksum mismatch|did NOT match|FAILED/);
      assert.equal(result.calls.length, 0);
      assert(!existsSync(join(f.directory, 'extracted')), 'corrupt Node archive must not be extracted');
      assert(!result.requests.includes(`https://nodejs.org/dist/latest-v24.x/${nodeArchive}`));
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert(existsSync(join(f.directory, 'extracted')));
      assert.equal(result.calls.length, 1);
      assert.equal(result.requests.includes(`https://nodejs.org/dist/latest-v24.x/${nodeArchive}`), mode === 'node-missing');
    }
  });
}

test('invalid source and unpinned accelerated packages fail before network or npm', t => {
  for (const [source, pkg] of [['invalid', 'open-desktop-remote-agent@0.1.4'], ['npmmirror', 'open-desktop-remote-agent@latest'], ['npmmirror', './custom.tgz']]) {
    const result = fixture(t, 'mirror').run(source, pkg);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 0);
    assert.equal(result.requests, '');
  }
});

test('official custom package behavior is unchanged', t => {
  const result = fixture(t, 'mirror').run('official', './custom.tgz');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.requests, '');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].at(-1), './custom.tgz');
  assert(result.calls[0].includes('--registry=https://registry.npmjs.org/'));
});

test('matching accelerated install preserves identity and skips all downloads', t => {
  const f = fixture(t, 'mirror');
  const installed = join(f.directory, 'install with spaces/node_modules/open-desktop-remote-agent');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ version: '0.1.4' }));
  writeFileSync(join(installed, 'dist/cli.mjs'), '');
  const identity = join(f.directory, 'install with spaces/identity-fixture');
  writeFileSync(identity, 'existing identity');
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.requests, '');
  assert.equal(result.calls.length, 0);
  assert.equal(readFileSync(identity, 'utf8'), 'existing identity');
});
