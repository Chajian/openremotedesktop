import {spawnSync} from "node:child_process";
import {describe, expect, it} from "vitest";
import {installerSource} from "../dashboard/installer.js";
import {supportLauncher} from "./support-launcher.js";

// An explicit Bash override permits the same fixture to run through WSL locally.
const shell = process.env.ODR_TEST_BASH ?? "/bin/bash";
describe.skipIf(process.platform === "win32" && !process.env.ODR_TEST_BASH)("downloaded POSIX support launchers", () => {
  for (const os of ["mac", "linux"] as const) {
    it.skipIf(os === "linux" && process.platform === "darwin").each(["success", "agent-failure", "checksum-failure", "expired"])(`${os} preserves failure and cleans installer (%s)`, mode => {
      const bytes = installerSource(os);
      const encoded = [...bytes].map(byte => "\\" + byte.toString(8).padStart(3, "0")).join("");
      const launcher = supportLauncher(new URL("https://remote.example.com"), "X".repeat(32), "0.1.6", "npmmirror", os);
      const fixture = `
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export ODR_FIXTURE_ROOT="$root"
mkdir "$root/tools" "$root/tmp"
export TMPDIR="$root/tmp"
export PATH="$root/tools:$PATH"
cat > "$root/tools/curl" <<'CURL'
#!/bin/bash
while [ "$1" != '-o' ]; do shift; done
if [ "$2" = /dev/null ]; then exit ${mode === "expired" ? 22 : 0}; fi
printf '%b' '${mode === "checksum-failure" ? "corrupt installer" : encoded}' > "$2"
CURL
cat > "$root/tools/bash" <<'BASH'
#!/bin/sh
printf ran > "$ODR_FIXTURE_ROOT/ran"
exit ${mode === "agent-failure" ? 19 : 0}
BASH
chmod +x "$root/tools/curl" "$root/tools/bash"
cat > "$root/launcher" <<'LAUNCHER'
${launcher}
LAUNCHER
set +e
/bin/bash "$root/launcher"
status=$?
set -e
printf 'STATUS:%s\\n' "$status"
if [ -e "$root/ran" ]; then echo AGENT_RAN; fi
if [ -n "$(ls -A "$root/tmp")" ]; then echo TEMP_LEAK; fi
`;
      const result = spawnSync(shell, ["-s"], {input:fixture, encoding:"utf8", timeout:20_000});
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(`STATUS:${mode === "success" ? 0 : mode === "agent-failure" ? 19 : 1}`);
      expect(result.stdout.includes("AGENT_RAN")).toBe(mode === "success" || mode === "agent-failure");
      expect(result.stdout).not.toContain("TEMP_LEAK");
    });
  }
});
