import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { inheritedStdioFixture, isAlive, within } from "./fixtures/inherited-stdio-fixture.js";

describe("owned stdio cleanup after direct-child exit", () => {
  it.each(["eof", "term"] as const)("releases only owned pipes after %s termination", async mode => {
    const fixture = await inheritedStdioFixture(mode);
    try {
      await fixture.start();
      const child = fixture.child;
      await fixture.transport.close();
      expect(fixture.transport.pid).toBeNull();
      expect(isAlive(child.pid!)).toBe(false);
      expect(isAlive(fixture.descendantPid)).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    } finally { await fixture.dispose(); }
  }, 10_000);

  it.skipIf(process.platform === "win32")("finishes the first concurrent close after SIGKILL with inherited output pipes", async () => {
    const fixture = await inheritedStdioFixture("kill");
    try {
      await fixture.start();
      const child = fixture.child;
      const events: string[] = [];
      child.once("exit", () => events.push("exit"));
      child.once("close", () => events.push("close"));
      const kill = vi.spyOn(child, "kill");
      const closing = fixture.transport.close();
      expect(fixture.transport.close()).toBe(closing);
      await closing;
      expect(kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(child.signalCode).toBe("SIGKILL");
      expect(events).toEqual(["exit", "close"]);
      expect(fixture.transport.pid).toBeNull();
      expect(isAlive(child.pid!)).toBe(false);
      expect(isAlive(fixture.descendantPid)).toBe(true);
      await fixture.transport.close();
      expect(events).toEqual(["exit", "close"]);
    } finally { vi.restoreAllMocks(); await fixture.dispose(); }
  }, 10_000);

  it("handles exit before close registration without signaling an exited child", async () => {
    const fixture = await inheritedStdioFixture("kill");
    try {
      await fixture.start();
      const child = fixture.child;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      expect(isAlive(fixture.descendantPid)).toBe(true);
      const kill = vi.spyOn(child, "kill");
      await within(fixture.transport.close(), 1_000);
      expect(kill).not.toHaveBeenCalled();
      expect(fixture.transport.pid).toBeNull();
    } finally { vi.restoreAllMocks(); await fixture.dispose(); }
  }, 10_000);

  it("keeps an actually live child owned when signaling fails and an error is interleaved", async () => {
    const fixture = await inheritedStdioFixture("kill");
    try {
      await fixture.start();
      const child = fixture.child;
      const errors: Error[] = [];
      const exitListeners = child.listenerCount("exit");
      fixture.transport.onerror = error => errors.push(error);
      const kill = vi.spyOn(child, "kill").mockReturnValue(false);
      const closing = fixture.transport.close();
      child.emit("error", new Error("fixture signal delivery failure"));
      await expect(closing).rejects.toThrow("close was not confirmed");
      expect(errors).toHaveLength(1);
      expect(fixture.transport.pid).toBe(child.pid);
      expect(isAlive(child.pid!)).toBe(true);
      expect(child.stdout.destroyed).toBe(false);
      expect(child.stderr.destroyed).toBe(false);
      expect(child.listenerCount("exit")).toBe(exitListeners);
      kill.mockRestore();
      await fixture.transport.close();
      expect(fixture.transport.pid).toBeNull();
      expect(isAlive(fixture.descendantPid)).toBe(true);
    } finally { vi.restoreAllMocks(); await fixture.dispose(); }
  }, 15_000);
});
