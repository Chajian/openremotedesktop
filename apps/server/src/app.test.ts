import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/database.js";

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
