import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { OwnedStdioTransport } from "../owned-stdio-transport.js";

export async function within<T>(pending: Promise<T>, milliseconds = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fixture deadline exceeded")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export async function inheritedStdioFixture(mode: "eof" | "term" | "kill") {
  const directory = await mkdtemp(join(tmpdir(), "odr-inherited-stdio-"));
  const transport = new OwnedStdioTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./inherited-stdio-server.mjs", import.meta.url)), mode, directory],
    env: getDefaultEnvironment(),
  });
  transport.stderr.resume();
  const sdk = new Client({ name: "inherited-stdio-test", version: "1.0.0" });
  let descendantPid: number | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  return {
    transport,
    get child() {
      if (!child) throw new Error("Fixture was not started");
      return child;
    },
    get descendantPid() {
      if (descendantPid === undefined) throw new Error("Fixture descendant was not started");
      return descendantPid;
    },
    async start() {
      const pending = sdk.connect(transport);
      child = Reflect.get(transport, "child") as ChildProcessWithoutNullStreams;
      await pending;
      const ready: unknown = JSON.parse(await readFile(join(directory, "ready.json"), "utf8"));
      if (!ready || typeof ready !== "object" || !("descendantPid" in ready) || typeof ready.descendantPid !== "number") {
        throw new Error("Fixture descendant did not register its PID");
      }
      descendantPid = ready.descendantPid;
    },
    async dispose() {
      // Tear down only this fixture. The stop file remains until the child has
      // exited, including when the tested parent was killed with SIGKILL.
      await writeFile(join(directory, "stop-descendant"), "stop");
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child && transport.pid !== null) await within(once(child, "close").then(() => undefined));
      if (descendantPid !== undefined) {
        const deadline = performance.now() + 3_000;
        while (isAlive(descendantPid)) {
          if (performance.now() >= deadline) throw new Error("Fixture descendant did not exit");
          await delay(20);
        }
        await readFile(join(directory, "descendant-exited"), "utf8");
      }
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
