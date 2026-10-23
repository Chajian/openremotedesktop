import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/database.js";
import { OperationRepository } from "./operations/operation-repository.js";
import { ConnectionRegistry } from "./relay/connection-registry.js";
import { HEARTBEAT_INTERVAL_MS } from "./relay/heartbeat.js";

describe("buildApp", () => {
  it("creates an injectable Fastify application from explicit dependencies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "open-desktop-remote-app-"));
    const databasePath = join(dir, "server.sqlite");
    const db = createDatabase(databasePath);
    const app = buildApp({
      db,
      config: {
        databasePath,
        publicBaseUrl: new URL("http://localhost:3000"),
        environment: "test",
      },
    });

    try {
      const response = await app.inject({ method: "GET", url: "/missing" });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("contains periodic cleanup and stale-sweep failures without killing later ticks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odr-maintenance-fault-"));
  const databasePath = join(dir, "server.sqlite");
  const db = createDatabase(databasePath);
  const intervals = vi.spyOn(globalThis, "setInterval");
  const events: Array<Record<string, unknown>> = [];
  const log = vi.spyOn(console, "log").mockImplementation((value: string) => {
    events.push(JSON.parse(value) as Record<string, unknown>);
  });
  const app = buildApp({ db, config: {
    databasePath, publicBaseUrl: new URL("http://localhost:3000"), environment: "test",
  } });
  try {
    await app.ready();
    const tick = (ms: number) => {
      const callback = intervals.mock.calls.find((call) => call[1] === ms)?.[0];
      if (typeof callback !== "function") throw new Error("Missing maintenance interval " + ms);
      return callback as () => void;
    };
    const cleanup = tick(60_000);
    const sweep = tick(HEARTBEAT_INTERVAL_MS);
    const originalCleanup = OperationRepository.prototype.cleanup;
    let cleanups = 0;
    vi.spyOn(OperationRepository.prototype, "cleanup").mockImplementation(function (this: OperationRepository) {
      if (++cleanups <= 2) throw Object.assign(new Error("SQLite temporarily unavailable"), { code: "SQLITE_BUSY" });
      return originalCleanup.call(this);
    });
    log.mockImplementationOnce(() => { throw new Error("logging sink failed"); });
    expect(() => cleanup()).not.toThrow();
    expect(() => cleanup()).not.toThrow();
    expect(() => cleanup()).not.toThrow();
    expect(cleanups).toBe(3);
    expect(events.some((record) => record.event === "operation.cleanup_failed")).toBe(true);

    const originalSweep = ConnectionRegistry.prototype.sweepStale;
    let sweeps = 0;
    vi.spyOn(ConnectionRegistry.prototype, "sweepStale").mockImplementation(function (this: ConnectionRegistry) {
      if (++sweeps === 1) throw new Error("socket termination failed");
      return originalSweep.call(this);
    });
    expect(() => sweep()).not.toThrow();
    expect(() => sweep()).not.toThrow();
    expect(sweeps).toBe(2);
    expect(events.some((record) => record.event === "relay.sweep_failed")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/missing" })).statusCode).toBe(404);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
