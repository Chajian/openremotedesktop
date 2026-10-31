import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {windowsCmdLauncher} from '../apps/server/src/dashboard/windows-launcher.ts';

test('launcher is a foreground CRLF batch file without encoded commands', () => {
  const text = windowsCmdLauncher("Write-Output 'fixture'");
  assert(text.startsWith('@echo off\r\n'));
  assert(!text.replaceAll('\r\n', '').includes('\n'));
  assert(text.includes('DisableDelayedExpansion'));
  assert(!text.includes('-EncodedCommand'));
  assert(!text.includes('-WindowStyle Hidden'));
});

for (const fails of [false, true]) {
  test(`real Windows launcher runs embedded PowerShell and preserves exit status (${fails})`, {skip: process.platform !== 'win32'}, () => {
    const root = mkdtempSync(join(tmpdir(), 'odr-launcher-'));
    try {
      const script = join(root, "客户 support & customer's ! file.cmd");
      writeFileSync(script, windowsCmdLauncher(fails ? "throw 'fixture failure'" : "Write-Output 'FIXTURE_LAUNCH_OK'"));
      const result = spawnSync('cmd.exe', ['/d', '/s', '/c', '""%ODR_TEST_SCRIPT%""'], {
        env: {...process.env, ODR_TEST_SCRIPT: script}, input: '\r\n', encoding:'utf8', timeout:20_000, windowsVerbatimArguments: true,
      });
      assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
      assert(result.stdout.includes(fails ? 'fixture failure' : 'FIXTURE_LAUNCH_OK'), result.stdout + result.stderr);
    } finally { rmSync(root, {recursive:true,force:true}); }
  });
}
