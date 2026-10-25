// Test-only preload for the installed CLI. It neither replaces Agent modules
// nor changes Desktop Commander: only credentials, observation and stop input.
import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";

let pendingReports = 0;
const report = (message) => {
  if (!process.connected) return;
  pendingReports++;
  process.channel?.ref();
  process.send(message, (error) => {
    if (error) writeFileSync(process.env.ODR_SMOKE_FORCED_CLEANUP, "fixture observation failed\n");
    if (--pendingReports === 0) process.channel?.unref();
  });
};
const keyringStub = `export class Entry {
  constructor() {
    process.send?.({ type: "fixture.keyring-isolated" }, () => {});
    throw new Error("Packaged smoke uses only its isolated credential file");
  }
}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@napi-rs/keyring") {
      return { url: "data:text/javascript," + encodeURIComponent(keyringStub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const executors = new Set();
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = Reflect.apply(originalSpawn, this, args);
  // Supplied credentials avoid browser/pairing processes. The parent requires
  // exactly one direct child: the executor started by the actual Agent runtime.
  executors.add(child);
  child.once("spawn", () => report({ type: "fixture.executor-spawn", pid: child.pid }));
  child.once("close", () => {
    executors.delete(child);
    report({ type: "fixture.executor-close", pid: child.pid });
  });
  return child;
};
syncBuiltinESMExports();

function cleanupFailure() {
  // Only failed fixtures use this fallback. The parent asserts this marker is
  // absent, so a harness kill can never masquerade as Agent-owned shutdown.
  if (executors.size) {
    writeFileSync(process.env.ODR_SMOKE_FORCED_CLEANUP, "fixture cleanup was required\n");
    for (const child of executors) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
}
process.on("message", (message) => {
  if (message?.type === "fixture.stop") {
    // Windows kill(SIGTERM) is not POSIX signal delivery. Inject the same CLI
    // stop event over this private test IPC channel, leaving its handler real.
    process.emit("SIGTERM");
  } else if (message?.type === "fixture.cleanup") {
    cleanupFailure();
    process.emit("SIGTERM");
  }
});
process.channel?.unref();
process.once("exit", cleanupFailure);
process.once("disconnect", () => { cleanupFailure(); process.emit("SIGTERM"); });
