import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = resolve(dirname(fileURLToPath(import.meta.url)), 'install-linux.sh');
const linux = process.platform === 'linux';
const releaseVersion = JSON.parse(readFileSync(new URL('../apps/agent/src/version.json', import.meta.url), 'utf8')).version;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'odr-linux-installer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home with spaces');
  const tools = join(directory, 'tools');
  mkdirSync(tools);
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: '', PATH: tools + ':' + process.env.PATH,
    ODR_TEST_OS: 'Linux', ODR_TEST_ARCH: 'x86_64', ODR_TEST_LIBC: 'glibc 2.28', ODR_TEST_DIR: directory };
  writeFileSync(join(tools, 'uname'), '#!/bin/sh\nif [ "$1" = -s ]; then printf "%s\\n" "$ODR_TEST_OS"; else printf "%s\\n" "$ODR_TEST_ARCH"; fi\n', { mode: 0o755 });
  writeFileSync(join(tools, 'getconf'), '#!/bin/sh\nprintf "%s\\n" "$ODR_TEST_LIBC"\n', { mode: 0o755 });
  writeFileSync(join(tools, 'curl'), '#!/bin/sh\nprintf requested > "$ODR_TEST_DIR/network"\nexit 91\n', { mode: 0o755 });
  const install = join(home, '.local/share/OpenDesktopRemote');
  return { directory, home, install, env, run(args = [], overrides = {}) {
    return spawnSync('/bin/bash', [installer, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20_000 });
  } };
}

test('Linux installer rejects invalid arguments without network or filesystem changes', { skip: !linux }, t => {
  for (const [args, message] of [
    [[], /valid HTTPS server origin/],
    [['--server', 'http://remote.example.test'], /valid HTTPS server origin/],
    [['--server', 'https://remote.example.test/path'], /valid HTTPS server origin/],
    [['--unknown'], /Unknown argument/],
    ...['--server', '--package', '--install-dir', '--download-source'].flatMap(flag => [
      [[flag], /Missing value/], [[flag, ''], /Missing value/], [[flag, '--install-only'], /Missing value/],
    ]),
  ]) {
    const f = fixture(t), result = f.run(args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, message);
    assert.equal(existsSync(f.home), false);
    assert.equal(existsSync(join(f.directory, 'network')), false);
  }
});

test('Linux installer rejects unsupported OS, CPU and libc before mutation', { skip: !linux }, t => {
  for (const [override, message] of [
    [{ ODR_TEST_OS: 'Darwin' }, /only supports Linux/],
    [{ ODR_TEST_ARCH: 'riscv64' }, /Unsupported Linux CPU/],
    [{ ODR_TEST_LIBC: 'musl' }, /glibc 2\.28 or newer/],
    [{ ODR_TEST_LIBC: 'glibc 2.27' }, /glibc 2\.28 or newer/],
  ]) {
    const f = fixture(t), result = f.run(['--server', 'https://remote.example.test'], override);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, message);
    assert.equal(existsSync(f.home), false);
    assert.equal(existsSync(join(f.directory, 'network')), false);
  }
});

test('Linux installer reuses private runtime, package and credentials in HOME or XDG paths', { skip: !linux }, t => {
  for (const [arch, useXdg] of [['x86_64', false], ['x64', true], ['aarch64', false], ['arm64', true]]) {
    const f = fixture(t);
    const xdg = join(f.directory, 'xdg data with spaces');
    const install = useXdg ? join(xdg, 'OpenDesktopRemote') : f.install;
    const runtime = join(install, 'runtime');
    mkdirSync(join(runtime, 'bin'), { recursive: true });
    copyFileSync(process.execPath, join(runtime, 'bin/node'));
    mkdirSync(join(runtime, 'lib/node_modules/npm/bin'), { recursive: true });
    writeFileSync(join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'), 'throw new Error("npm should not run");');
    const pkg = join(install, 'node_modules/open-desktop-remote-agent');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: releaseVersion }));
    writeFileSync(join(pkg, 'dist/cli.mjs'), 'throw new Error("install-only must not start the Agent");');
    const credentials = join(f.home, '.open-desktop-remote');
    mkdirSync(credentials, { recursive: true });
    writeFileSync(join(credentials, 'device.json'), 'fixture-existing-identity');
    const result = f.run(['--server', 'https://remote.example.test', '--install-only'], {
      ODR_TEST_ARCH: arch, XDG_DATA_HOME: useXdg ? xdg : '',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /already installed; keeping existing device identity/);
    assert.equal(readFileSync(join(credentials, 'device.json'), 'utf8'), 'fixture-existing-identity');
    assert.equal(existsSync(join(f.directory, 'network')), false);
  }
});
