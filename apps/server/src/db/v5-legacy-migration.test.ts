import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations, SCHEMA_V1_SQL } from "./migrations.js";

describe("V4 to V5 migration compatibility", () => {
  it("preserves the legacy owner, device IDs, credentials and approved OAuth clients", () => {
    const db = new BetterSqlite3(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      db.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        ${SCHEMA_V1_SQL}
        ALTER TABLE oauth_tokens ADD COLUMN originating_auth_code_hash TEXT;
        CREATE TABLE device_access_tokens (
          id TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id),
          token_hash TEXT UNIQUE, created_at INTEGER,
          expires_at INTEGER, revoked_at INTEGER
        );
        ALTER TABLE oauth_clients ADD COLUMN authorized_owner_id TEXT REFERENCES owner(id);
        ALTER TABLE oauth_clients ADD COLUMN authorized_at INTEGER;
        ALTER TABLE oauth_clients ADD COLUMN revoked_at INTEGER;
        INSERT INTO schema_migrations VALUES (1,1),(2,2),(3,3),(4,4);
      `);      db.prepare("INSERT INTO owner (id,password_hash,created_at) VALUES ('legacy','hash',1)").run();
      db.prepare(
        "INSERT INTO devices (id,name,created_at,last_seen_at) VALUES ('device-1','Legacy PC',10,20)"
      ).run();
      db.prepare(
        "INSERT INTO device_credentials (id,device_id,refresh_hash,created_at) VALUES ('dc','device-1','refresh-hash',21)"
      ).run();
      db.prepare(
        "INSERT INTO oauth_clients (client_id,redirect_uris_json,grant_types_json,response_types_json,token_endpoint_auth_method,created_at,authorized_owner_id,authorized_at) " +
        "VALUES ('client','[]','[]','[]','none',20,'legacy',25)"
      ).run();
      db.prepare(
        "INSERT INTO oauth_tokens (id,token_type,token_hash,client_id,owner_id,resource,scope,expires_at) " +
        "VALUES ('access','access','access-hash','client','legacy','https://example.com/mcp','mcp',9999999999999)"
      ).run();
      runMigrations(db);
      const device = db.prepare("SELECT id,name,owner_id AS ownerId FROM devices WHERE id='device-1'").get();      expect(device).toEqual({ id: "device-1", name: "Legacy PC", ownerId: "legacy" });
      expect(db.prepare("SELECT refresh_hash FROM device_credentials WHERE device_id='device-1'").get())
        .toEqual({ refresh_hash: "refresh-hash" });
      expect(db.prepare(
        "SELECT owner_id,revoked_at FROM oauth_client_grants WHERE client_id='client'"
      ).get()).toEqual({ owner_id: "legacy", revoked_at: null });
      expect(db.prepare(
        "SELECT token_hash,owner_id FROM oauth_tokens WHERE id='access'"
      ).get()).toEqual({ token_hash: "access-hash", owner_id: "legacy" });
      expect(db.prepare(
        "SELECT id FROM owner WHERE id='legacy'"
      ).get()).toEqual({ id: "legacy" });
      expect(db.prepare(
        "SELECT version FROM schema_migrations WHERE version=5"
      ).get()).toEqual({ version: 5 });
      runMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_client_grants").get())
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
