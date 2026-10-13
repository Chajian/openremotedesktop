import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  OwnerAlreadyInitializedError,
  OwnerRepository,
} from "./owner-repository.js";
import { SessionRepository } from "./session-repository.js";

const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

function fixture(environment: "test" | "production" = "test") {
  const dir = mkdtempSync(join(tmpdir(), "odr-owner-auth-"));
  const databasePath = join(dir, "server.sqlite");
  const db = createDatabase(databasePath);
  const cleanup = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { db, databasePath, environment };
}

describe("owner password hashing", () => {
  it("stores a salted scrypt encoding and verifies in constant-shape API", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded).not.toContain("correct horse battery staple");
    expect(encoded.startsWith("scrypt$")).toBe(true);
    await expect(
      verifyPassword("correct horse battery staple", encoded),
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong", encoded)).resolves.toBe(false);
  });
});

describe("single-owner bootstrap", () => {
  it("allows exactly one owner to be initialized", async () => {
    const { db } = fixture();
    const owners = new OwnerRepository(db);

    const owner = await owners.bootstrapOwner({ password: "first-password" });
    expect(owner.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await expect(
      owners.bootstrapOwner({ password: "second-password" }),
    ).rejects.toBeInstanceOf(OwnerAlreadyInitializedError);
  });

  it("serializes concurrent bootstrap attempts so exactly one succeeds", async () => {
    const { db } = fixture();
    const owners = new OwnerRepository(db);

    const results = await Promise.allSettled([
      owners.bootstrapOwner({ password: "password-a" }),
      owners.bootstrapOwner({ password: "password-b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM owner").get(),
    ).toEqual({ count: 1 });
  });
});

describe("bootstrap route", () => {
  it("initializes once and then disables public bootstrap", async () => {
    const { db, databasePath } = fixture();
    const app = buildApp({
      db,
      config: {
        databasePath,
        publicBaseUrl: new URL("http://localhost:3000"),
        environment: "test",
      },
    });
    cleanups.push(() => app.close());

    const first = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { password: "first-password" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { password: "second-password" },
    });

    expect(first.statusCode).toBe(201);
    expect(first.json().ownerId).toBeTypeOf("string");
    expect(second.statusCode).toBe(409);
  });
});

describe("owner sessions and login route", () => {
  it("rejects a wrong password and sets no session cookie", async () => {
    const { db, databasePath } = fixture();
    const owners = new OwnerRepository(db);
    await owners.bootstrapOwner({ password: "correct-password" });
    const app = buildApp({
      db,
      config: {
        databasePath,
        publicBaseUrl: new URL("http://localhost:3000"),
        environment: "test",
      },
    });
    cleanups.push(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "wrong-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("sets an HttpOnly SameSite=Lax Secure cookie after correct production login", async () => {
    const { db, databasePath } = fixture("production");
    const owners = new OwnerRepository(db);
    await owners.bootstrapOwner({ password: "correct-password" });
    const app = buildApp({
      db,
      config: {
        databasePath,
        publicBaseUrl: new URL("https://remote.example.com"),
        environment: "production",
      },
    });
    cleanups.push(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "correct-password" },
    });

    expect(response.statusCode).toBe(204);
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("odr_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("stores only a session verifier and enforces expiry", async () => {
    const { db } = fixture();
    const owners = new OwnerRepository(db);
    const owner = await owners.bootstrapOwner({ password: "password" });
    let now = 1_000_000;
    const sessions = new SessionRepository(db, {
      now: () => now,
      ttlMs: 5_000,
    });

    const rawToken = sessions.createOwnerSession(owner.id);
    const row = db
      .prepare("SELECT token_hash AS tokenHash FROM owner_sessions")
      .get() as { tokenHash: string };

    expect(row.tokenHash).not.toBe(rawToken);
    expect(sessions.verifyOwnerSession(rawToken)).toEqual({ ownerId: owner.id });

    now += 5_001;
    expect(sessions.verifyOwnerSession(rawToken)).toBeNull();
  });
});
