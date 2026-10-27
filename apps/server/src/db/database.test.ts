import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "./database.js";
import { SCHEMA_V1_SQL } from "./migrations.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "open-desktop-remote-db-"));
  tempDirs.push(dir);
  return join(dir, "server.sqlite");
}

describe("database migrations", () => {
  it("creates every durable V1 table", () => {
    const db = createDatabase(createTempDatabasePath());
    try {
      const tableRows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      expect(tableRows.map((row) => row.name)).toEqual([
        "device_access_tokens",
        "device_credentials",
        "device_deletion_events",
        "device_pairings",
        "devices",
        "github_login_attempts",
        "oauth_client_grants",
        "oauth_clients",
        "oauth_codes",
        "oauth_tokens",
        "operations",
        "owner",
        "owner_sessions",
        "schema_migrations",
        "settings",
      ]);
    } finally {
      db.close();
    }
  });

  it("can run migrations repeatedly without changing the schema", () => {
    const db = createDatabase(createTempDatabasePath());
    try {
      const before = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all();
      runMigrations(db);
      runMigrations(db);
      const after = db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all();

      expect(after).toEqual(before);
      expect(after).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
      ]);
    } finally {
      db.close();
    }
  });

  it("migrates deletion state on new and upgraded databases", () => {
    const db = createDatabase(createTempDatabasePath());
    try {
      const columns = db.pragma("table_info(devices)") as Array<{name: string}>;
      expect(columns.map(c => c.name)).toContain("deleted_at");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_deletion_events'").get()).toEqual({name:"device_deletion_events"});
    } finally {db.close();}
  });

  it("adds an authorization-code lineage column for token revocation", () => {
    const db = createDatabase(createTempDatabasePath());
    try {
      const columns = db.pragma("table_info(oauth_tokens)") as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain(
        "originating_auth_code_hash",
      );
    } finally {
      db.close();
    }
  });

  it("adds explicit OAuth client approval and revocation columns", () => {
    const db = createDatabase(createTempDatabasePath());
    try {
      const columns = db.pragma("table_info(oauth_clients)") as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["authorized_owner_id", "authorized_at", "revoked_at"]),
      );
    } finally {
      db.close();
    }
  });

  it("preserves explicitly consented clients during a V3 database upgrade", () => {
    const db = new BetterSqlite3(createTempDatabasePath());
    try {
      db.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        ${SCHEMA_V1_SQL}
        ALTER TABLE oauth_tokens ADD COLUMN originating_auth_code_hash TEXT;
        CREATE TABLE device_access_tokens (
          id TEXT PRIMARY KEY, device_id TEXT NOT NULL, token_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
        );
        INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1), (2, 2), (3, 3);
      `);
      db.prepare("INSERT INTO owner (id, password_hash, created_at) VALUES (?, ?, ?)").run("owner", "test", 1);
      const addClient = db.prepare(`
        INSERT INTO oauth_clients (client_id, redirect_uris_json, grant_types_json,
          response_types_json, token_endpoint_auth_method, created_at)
        VALUES (?, ?, ?, ?, ?, 1)
      `);
      for (const clientId of ["consented", "registered-only"]) {
        addClient.run(clientId, '["https://client.example/callback"]',
          '["authorization_code"]', '["code"]', "none");
      }
      db.prepare(`
        INSERT INTO oauth_codes (code_hash, client_id, owner_id, redirect_uri,
          code_challenge, resource, scope, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run("hash", "consented", "owner", "https://client.example/callback",
        "challenge", "https://remote.example.com/mcp", "mcp", Date.now() + 60_000);
      runMigrations(db);
      const read = db.prepare(`
        SELECT authorized_owner_id AS ownerId, authorized_at AS approvedAt
          FROM oauth_clients WHERE client_id = ?
      `);
      expect(read.get("consented")).toMatchObject({
        ownerId: "owner", approvedAt: expect.any(Number),
      });
      expect(read.get("registered-only")).toEqual({ ownerId: null, approvedAt: null });
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 4").get())
        .toEqual({ version: 4 });
    } finally {
      db.close();
    }
  });

  it("enables foreign keys and WAL mode", () => {
    const db = createDatabase(createTempDatabasePath());
    try {
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
    }
  });
});
