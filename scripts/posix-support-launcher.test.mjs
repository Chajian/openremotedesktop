import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Run the production TypeScript builders using Node 24, without installing the
// Server workspace. Resolve only its local emitted .js references to .ts source.
const serverSource = new URL('../apps/server/src/', import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(serverSource) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const emitted = new URL(specifier, context.parentURL);
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (!existsSync(emitted) && existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { supportLauncher } = await import('../apps/server/src/support/support-launcher.ts');
hook.deregister();

const nativeOS = process.platform === 'darwin' ? 'mac' : process.platform === 'linux' ? 'linux' : undefined;
// Retain the macOS shell simulation on Linux, and execute macOS natively on CI.
const platforms = nativeOS === 'linux' ? ['linux', 'mac'] : nativeOS ? [nativeOS] : [];
const sources = ['official', 'npmmirror'];
const modes = ['success', 'installer-failure', 'checksum-failure', 'expired', 'download-failure'];
const completedNative = new Set();
if (process.env.ODR_TEST_REQUIRE_NATIVE_POSIX === '1') {
  assert(nativeOS, 'POSIX launcher CI requires a native macOS or Linux runner');
}
if (!nativeOS) test('POSIX launcher execution requires macOS or Linux', { skip: true }, () => {});
after(() => {
  if (nativeOS) assert.equal(completedNative.size, modes.length * sources.length,
    `Expected every native ${nativeOS} launcher case to execute; skipped or undiscovered cases are not acceptance`);
});

const invite = 'X'.repeat(32);
const origin = new URL('https://remote.example.test');
const version = JSON.parse(readFileSync(new URL('../apps/agent/src/version.json', import.meta.url), 'utf8')).version;

for (const os of platforms) for (const source of sources) for (const mode of modes) {
  test(`${os} downloaded support / ${source} / ${mode}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'odr launcher fixture '));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const tools = join(directory, 'tools');
    const temporary = join(directory, 'temporary files');
    mkdirSync(tools);
    mkdirSync(temporary);
    const installer = join(directory, 'installer');
    const platformFile = os === 'mac' ? 'macos' : 'linux';
    copyFileSync(new URL(`./install-${platformFile}.sh`, import.meta.url), installer);
    if (mode === 'checksum-failure') writeFileSync(installer, 'corrupt installer');
    const argsFile = join(directory, 'arguments');
    const requestsFile = join(directory, 'requests');
    writeFileSync(join(tools, 'curl'), `#!/bin/bash
set -eu
for arg in "$@"; do
  case "$arg" in https://*) printf '%s\\n' "$arg" >> "$ODR_FIXTURE_REQUESTS" ;; esac
done
while [ "$1" != '-o' ]; do shift; done
if [ "$2" = /dev/null ]; then exit ${mode === 'expired' ? 22 : 0}; fi
${mode === 'download-failure' ? 'exit 22' : 'cp "$ODR_FIXTURE_INSTALLER" "$2"'}
`, { mode: 0o755 });
    // Replace only the final installer interpreter. Real curl/checksum command
    // orchestration runs in the generated wrapper; no real Agent or network runs.
    writeFileSync(join(tools, 'bash'), `#!/bin/sh
printf '%s\\n' "$@" > "$ODR_FIXTURE_ARGUMENTS"
exit ${mode === 'installer-failure' ? 19 : 0}
`, { mode: 0o755 });
    const launcher = join(directory, 'downloaded launcher');
    writeFileSync(launcher, supportLauncher(origin, invite, version, source, os));
    const result = spawnSync('/bin/bash', [launcher], {
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, TMPDIR: temporary,
        ODR_FIXTURE_INSTALLER: installer, ODR_FIXTURE_ARGUMENTS: argsFile, ODR_FIXTURE_REQUESTS: requestsFile },
      encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL',
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stdout + result.stderr);
    const expectedStatus = mode === 'success' ? 0 : mode === 'installer-failure' ? 19 : mode === 'download-failure' ? 22 : 1;
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    const ran = mode === 'success' || mode === 'installer-failure';
    assert.equal(existsSync(argsFile), ran, 'invalid invite/download/checksum must never reach the installer');
    if (ran) {
      const args = readFileSync(argsFile, 'utf8').trimEnd().split('\n');
      assert.equal(existsSync(args[0]), false, 'downloaded temporary installer must be removed');
      assert.deepEqual(args.slice(1), ['--server', origin.origin, '--support-invite', invite,
        '--package', `open-desktop-remote-agent@${version}`, '--accept-support',
        ...(source === 'npmmirror' ? ['--download-source', 'npmmirror'] : [])]);
    }
    assert.deepEqual(readdirSync(temporary), [], 'wrapper must clean temporary files on success and failure');
    assert.deepEqual(readFileSync(requestsFile, 'utf8').trimEnd().split('\n'), [
      `${origin.origin}/api/support/invite/${invite}`,
      ...(mode === 'expired' ? [] : [`${origin.origin}/install/${platformFile}.sh`]),
    ]);
    if (os === nativeOS) completedNative.add(`${source}/${mode}`);
  });
}
