import type BetterSqlite3 from "better-sqlite3";

export const SCHEMA_V1_SQL = "CREATE TABLE owner (\n  id TEXT PRIMARY KEY,\n  password_hash TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n);\n\nCREATE TABLE owner_sessions (\n  id TEXT PRIMARY KEY,\n  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,\n  token_hash TEXT NOT NULL UNIQUE,\n  expires_at INTEGER NOT NULL,\n  created_at INTEGER NOT NULL\n);\n\nCREATE TABLE oauth_clients (\n  client_id TEXT PRIMARY KEY,\n  redirect_uris_json TEXT NOT NULL,\n  grant_types_json TEXT NOT NULL,\n  response_types_json TEXT NOT NULL,\n  token_endpoint_auth_method TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n);\n\nCREATE TABLE oauth_codes (\n  code_hash TEXT PRIMARY KEY,\n  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,\n  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,\n  redirect_uri TEXT NOT NULL,\n  code_challenge TEXT NOT NULL,\n  resource TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  expires_at INTEGER NOT NULL,\n  consumed_at INTEGER\n);\n\nCREATE TABLE oauth_tokens (\n  id TEXT PRIMARY KEY,\n  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),\n  token_hash TEXT NOT NULL UNIQUE,\n  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,\n  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,\n  resource TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  expires_at INTEGER NOT NULL,\n  revoked_at INTEGER,\n  parent_id TEXT REFERENCES oauth_tokens(id)\n);\n\nCREATE TABLE devices (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  platform TEXT,\n  agent_version TEXT,\n  desktop_commander_version TEXT,\n  created_at INTEGER NOT NULL,\n  last_seen_at INTEGER,\n  revoked_at INTEGER\n);\n\nCREATE TABLE device_pairings (\n  device_code_hash TEXT PRIMARY KEY,\n  user_code TEXT NOT NULL UNIQUE,\n  requested_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL,\n  approved_at INTEGER,\n  device_id TEXT REFERENCES devices(id)\n);\n\nCREATE TABLE device_credentials (\n  id TEXT PRIMARY KEY,\n  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,\n  refresh_hash TEXT NOT NULL UNIQUE,\n  created_at INTEGER NOT NULL,\n  revoked_at INTEGER\n);\n\nCREATE TABLE settings (\n  key TEXT PRIMARY KEY,\n  value_json TEXT NOT NULL\n);\n\nCREATE INDEX idx_owner_sessions_token_hash ON owner_sessions(token_hash);\nCREATE INDEX idx_oauth_tokens_token_hash ON oauth_tokens(token_hash);\nCREATE INDEX idx_device_pairings_user_code ON device_pairings(user_code);\nCREATE INDEX idx_device_credentials_refresh_hash ON device_credentials(refresh_hash);\n";

function hasMigration(db: BetterSqlite3.Database, version: number): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version),
  );
}

function recordMigration(db: BetterSqlite3.Database, version: number): void {
  db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(version, Date.now());
}

export function runMigrations(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  if (!hasMigration(db, 1)) {
    db.transaction(() => {
      db.exec(SCHEMA_V1_SQL);
      recordMigration(db, 1);
    })();
  }

  if (!hasMigration(db, 2)) {
    db.transaction(() => {
      db.exec(
        "ALTER TABLE oauth_tokens ADD COLUMN originating_auth_code_hash TEXT",
      );
      db.exec(
        "CREATE INDEX idx_oauth_tokens_auth_code_hash ON oauth_tokens(originating_auth_code_hash)",
      );
      recordMigration(db, 2);
    })();
  }

  if (!hasMigration(db, 3)) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE device_access_tokens (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX idx_device_access_tokens_hash
          ON device_access_tokens(token_hash);
        CREATE INDEX idx_device_access_tokens_device
          ON device_access_tokens(device_id);
      `);
      recordMigration(db, 3);
    })();
  }

  if (!hasMigration(db, 4)) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE oauth_clients ADD COLUMN authorized_owner_id TEXT REFERENCES owner(id);
        ALTER TABLE oauth_clients ADD COLUMN authorized_at INTEGER;
        ALTER TABLE oauth_clients ADD COLUMN revoked_at INTEGER;
      `);
      // Existing auth codes were created only after explicit Owner consent.
      // Preserve existing ChatGPT connections when upgrading the database.
      db.prepare(`
        UPDATE oauth_clients
           SET authorized_owner_id = (
             SELECT owner_id FROM oauth_codes
              WHERE oauth_codes.client_id = oauth_clients.client_id
              ORDER BY expires_at DESC LIMIT 1
           ),
               authorized_at = ?
         WHERE EXISTS (
           SELECT 1 FROM oauth_codes
            WHERE oauth_codes.client_id = oauth_clients.client_id
         )
      `).run(Date.now());
      recordMigration(db, 4);
    })();
  }

  if (!hasMigration(db, 5)) {
    db.transaction(() => {
      db.exec(
        "ALTER TABLE owner ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local';" +
        "ALTER TABLE owner ADD COLUMN github_user_id TEXT;" +
        "ALTER TABLE owner ADD COLUMN github_login TEXT;" +
        "CREATE UNIQUE INDEX idx_owner_github_user_id ON owner(github_user_id);" +
        "ALTER TABLE devices ADD COLUMN owner_id TEXT REFERENCES owner(id);" +
        "CREATE INDEX idx_devices_owner_id ON devices(owner_id);" +
        "CREATE TABLE oauth_client_grants (client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE, authorized_at INTEGER NOT NULL, revoked_at INTEGER, PRIMARY KEY(client_id, owner_id));" +
        "CREATE TABLE github_login_attempts (state_hash TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, code_verifier TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);"
      );
      db.exec(
        "UPDATE devices SET owner_id = (SELECT id FROM owner WHERE auth_source = 'local' ORDER BY created_at LIMIT 1) WHERE owner_id IS NULL;" +
        "INSERT INTO oauth_client_grants (client_id, owner_id, authorized_at, revoked_at) SELECT client_id, authorized_owner_id, authorized_at, revoked_at FROM oauth_clients WHERE authorized_owner_id IS NOT NULL AND authorized_at IS NOT NULL;"
      );
      const unowned = db.prepare("SELECT COUNT(*) AS count FROM devices WHERE owner_id IS NULL").get() as { count: number };
      if (unowned.count > 0) throw new Error("Cannot migrate devices without a legacy Owner");
      recordMigration(db, 5);
    })();
  }

  if (!hasMigration(db, 6)) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE operations (
          operation_id TEXT PRIMARY KEY,
          requested_by_user_id TEXT NOT NULL,
          originating_client_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          device_owner_id_at_creation TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          boot_id TEXT,
          phase TEXT NOT NULL CHECK (phase IN ('dispatched', 'unknown', 'completed')),
          outcome TEXT CHECK (outcome IN ('success', 'error', 'unknown')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          retention_until INTEGER NOT NULL,
          completed_at INTEGER,
          terminal_digest TEXT,
          conflict INTEGER NOT NULL DEFAULT 0,
          cancel_requested INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_operations_retention ON operations(retention_until);
      `);
      recordMigration(db, 6);
    })();
  }

  if (!hasMigration(db, 7)) {
    db.transaction(() => {
      db.exec(`ALTER TABLE devices ADD COLUMN deleted_at INTEGER;
        CREATE INDEX idx_devices_deleted_at ON devices(deleted_at);
        CREATE TABLE device_deletion_events (
          device_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          deleted_at INTEGER NOT NULL
        );
        CREATE INDEX idx_device_deletion_events_time ON device_deletion_events(deleted_at);`);
      recordMigration(db, 7);
    })();
  }

}
