import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadServerConfig } from "../config.js";
import { createDatabase } from "../db/database.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("production server config", () => {
  it("requires an explicit public base URL in production", () => {
    expect(() =>
      loadServerConfig({
        NODE_ENV: "production",
        ODR_DATABASE_PATH: "/data/server.sqlite",
      }),
    ).toThrow(/ODR_PUBLIC_BASE_URL/);
  });

  it("rejects non-HTTPS production public URLs", () => {
    expect(() =>
      loadServerConfig({
        NODE_ENV: "production",
        ODR_DATABASE_PATH: "/data/server.sqlite",
        ODR_PUBLIC_BASE_URL: "http://remote.example.com",
      }),
    ).toThrow(/https/i);
  });

  it("parses secondary HTTPS origins without changing the OAuth issuer", () => {
    const env = {NODE_ENV:"production",ODR_PUBLIC_BASE_URL:"https://www.xiaofenmao.xyz"};
    const config = loadServerConfig({...env,
      ODR_ADDITIONAL_PUBLIC_BASE_URLS:"https://openremotedesktop.com"});
    expect(config.publicBaseUrl.origin).toBe("https://www.xiaofenmao.xyz");
    expect(config.additionalPublicBaseUrls?.map((x) => x.origin))
      .toEqual(["https://openremotedesktop.com"]);
    for (const invalid of [
      "https://www.xiaofenmao.xyz", "http://openremotedesktop.com",
      "https://openremotedesktop.com/extra",
      "https://openremotedesktop.com?query=1",
      "https://openremotedesktop.com,https://openremotedesktop.com",
    ]) {
      expect(() => loadServerConfig({...env,ODR_ADDITIONAL_PUBLIC_BASE_URLS:invalid}))
        .toThrow(/ODR_ADDITIONAL_PUBLIC_BASE_URLS/);
    }
  });

  it("allows localhost HTTP in development", () => {
    const config = loadServerConfig({
      NODE_ENV: "development",
      ODR_DATABASE_PATH: "./data/dev.sqlite",
      ODR_PUBLIC_BASE_URL: "http://localhost:3000",
      ODR_PORT: "3000",
    });
    expect(config.publicBaseUrl.toString()).toBe("http://localhost:3000/");
    expect(config.listenPort).toBe(3000);
  });
});

describe("health routes", () => {
  it("reports liveness/readiness without exposing work payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odr-health-"));
    const databasePath = join(dir, "server.sqlite");
    const db = createDatabase(databasePath);
    const app = buildApp({
      db,
      config: {
        databasePath,
        publicBaseUrl: new URL("https://remote.example.com"),
        environment: "test",
      },
    });
    cleanups.push(async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const live = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });

    const serialized = live.body + ready.body;
    expect(serialized).not.toMatch(/deviceId|toolName|content|token|credential/i);
  });
});
