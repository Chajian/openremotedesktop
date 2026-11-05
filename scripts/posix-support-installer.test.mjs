import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invite = 'fixture_' + 'X'.repeat(24);
const server = 'https://remote.example.test';
const releaseVersion = JSON.parse(readFileSync(join(root, 'apps/agent/src/version.json'), 'utf8')).version;

function fixture(t, platform, { custom = false, xdg = false, version = releaseVersion } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'odr-posix-support-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home with spaces');
  const data = xdg ? join(directory, 'xdg data') : join(home, '.local/share');
  const base = platform === 'macos' ? join(home, 'Library/Application Support') : data;
  const install = custom ? join(directory, 'custom install') : join(base, 'OpenRemoteSupport');
  const tools = join(directory, 'tools');
  mkdirSync(tools);
  // macOS script execution on Linux is a shell fixture, not macOS install evidence.
  writeFileSync(join(tools, 'uname'), '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n', { mode: 0o755 });
  writeFileSync(join(tools, 'getconf'), '#!/bin/sh\necho "glibc 2.28"\n', { mode: 0o755 });
  writeFileSync(join(tools, 'curl'), '#!/bin/sh\nprintf requested > "$ODR_TEST_DIR/network"\nexit 91\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: xdg ? data : '', PATH: tools + ':' + process.env.PATH,
    ODR_TEST_DIR: directory, ODR_TEST_EXIT: '0' };
  const args = [join(root, `scripts/install-${platform}.sh`), '--server', server, ...(custom ? ['--install-dir', install] : [])];
  return { directory, home, install, env, args, seed() {
    const runtime = join(install, 'runtime');
    mkdirSync(join(runtime, 'bin'), { recursive: true });
    copyFileSync(process.execPath, join(runtime, 'bin/node'));
    mkdirSync(join(runtime, 'lib/node_modules/npm/bin'), { recursive: true });
    writeFileSync(join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'), 'throw new Error("matching package must be reused");');
    const pkg = join(install, 'node_modules/open-desktop-remote-agent');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(pkg, 'dist/cli.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.ODR_TEST_DIR + '/arguments.json', JSON.stringify(process.argv.slice(2)));
      if (process.env.ODR_TEST_WAIT === '1') {
        process.on('SIGINT', () => process.exit(23));
        setInterval(() => {}, 1000);
        console.log('fixture-ready:' + process.pid);
      } else process.exit(Number(process.env.ODR_TEST_EXIT));
    `);
    const credentials = join(home, '.open-desktop-remote');
    mkdirSync(credentials, { recursive: true });
    writeFileSync(join(credentials, 'device.json'), 'permanent-identity-fixture');
  }, run(extra = [], overrides = {}) {
    return spawnSync('/bin/bash', [...args, ...extra], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20_000 });
  } };
}

for (const platform of ['macos', 'linux']) {
  // Linux requires GNU utilities; exercise it on Linux, not a macOS host.
  const posix = process.platform !== 'win32' && (platform !== 'linux' || process.platform === 'linux');
  test(`${platform} support guards reject invalid consent, token and package before mutation`, { skip: !posix }, t => {
    for (const [args, message] of [
      [['--accept-support'], /requires a support invitation/],
      ...['', 'X'.repeat(31), 'X'.repeat(33), '/'.repeat(32)].map(token => [['--support-invite', token], /Missing value|Invalid support invite/]),
      [['--support-invite'], /Missing value/],
      [['--support-invite', '--install-only'], /Missing value/],
      ...['./custom.tgz', 'open-desktop-remote-agent@latest', 'open-desktop-remote-agent@0.1.6-beta.1'].map(pkg => [
        ['--support-invite', invite, '--package', pkg], /exact.*npm Agent version/]),
      [['--support-invite', invite, '--package', 'open-desktop-remote-agent@0.1.3'], /does not support temporary sessions/],
      [['--support-invite', invite, '--accept-support', '--package', 'open-desktop-remote-agent@0.1.5'], /require Agent 0.1.6 or newer/],
    ]) {
      const f = fixture(t, platform), result = f.run(args);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, message);
      assert.equal(existsSync(f.home), false);
      assert.equal(existsSync(join(f.directory, 'network')), false);
      assert(!result.stderr.includes(invite), 'do not log invitation');
    }
  });

  for (const mode of ['manual', 'accepted', 'install-only', 'failure', 'custom', 'xdg', 'minimum']) {
    test(`${platform} isolated support ${mode} reuses installation and preserves permanent credentials`, { skip: !posix }, t => {
      const f = fixture(t, platform, { custom: mode === 'custom', xdg: mode === 'xdg', version: mode === 'minimum' ? '0.1.4' : releaseVersion });
      f.seed();
      const args = ['--support-invite', invite, '--download-source', 'npmmirror',
        ...(mode === 'accepted' ? ['--accept-support'] : []),
        ...(mode === 'install-only' ? ['--install-only', '--accept-support'] : []),
        ...(mode === 'minimum' ? ['--package', 'open-desktop-remote-agent@0.1.4'] : [])];
      const result = f.run(args, { ODR_TEST_EXIT: mode === 'failure' ? '19' : '0' });
      assert.equal(result.status, mode === 'failure' ? 19 : 0, result.stdout + result.stderr);
      assert.equal(readFileSync(join(f.home, '.open-desktop-remote/device.json'), 'utf8'), 'permanent-identity-fixture');
      assert.equal(existsSync(join(f.directory, 'network')), false);
      assert(!result.stdout.includes(invite));
      const evidence = join(f.directory, 'arguments.json');
      if (mode === 'install-only') assert.equal(existsSync(evidence), false);
      else assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), ['agent', 'support', '--server', server, '--invite', invite,
        ...(mode === 'accepted' ? ['--accept-support'] : [])]);
    });
  }

  test(`${platform} foreground support replaces shell and receives SIGINT`, { skip: !posix }, async t => {
    const f = fixture(t, platform);
    f.seed();
    const child = spawn('/bin/bash', [...f.args, '--support-invite', invite], { env: { ...f.env, ODR_TEST_WAIT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let output = '';
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Agent fixture did not start: ' + output)), 10_000);
      child.once('error', reject);
      child.stdout.on('data', bytes => {
        output += bytes;
        const match = /fixture-ready:(\d+)/.exec(output);
        if (match) { clearTimeout(timer); assert.equal(Number(match[1]), child.pid, 'installer must exec the Agent'); resolveReady(); }
      });
      child.stderr.on('data', bytes => { output += bytes; });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Unexpected early exit ' + code + ': ' + output)); });
    });
    const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    child.kill('SIGINT');
    assert.deepEqual(await exited, { code: 23, signal: null });
  });
}
