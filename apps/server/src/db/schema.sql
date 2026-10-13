CREATE TABLE owner (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  auth_source TEXT NOT NULL DEFAULT 'local',
  github_user_id TEXT,
  github_login TEXT
);

CREATE TABLE owner_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL,
  response_types_json TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  authorized_owner_id TEXT REFERENCES owner(id),
  authorized_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE oauth_client_grants (
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  authorized_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (client_id, owner_id)
);

CREATE TABLE github_login_attempts (
  state_hash TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  parent_id TEXT REFERENCES oauth_tokens(id),
  originating_auth_code_hash TEXT
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT REFERENCES owner(id),
  platform TEXT,
  agent_version TEXT,
  desktop_commander_version TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE device_pairings (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  device_id TEXT REFERENCES devices(id)
);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE device_access_tokens (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_owner_github_user_id ON owner(github_user_id);
CREATE INDEX idx_devices_owner_id ON devices(owner_id);
CREATE INDEX idx_owner_sessions_token_hash ON owner_sessions(token_hash);
CREATE INDEX idx_oauth_tokens_token_hash ON oauth_tokens(token_hash);
CREATE INDEX idx_device_pairings_user_code ON device_pairings(user_code);
CREATE INDEX idx_device_credentials_refresh_hash ON device_credentials(refresh_hash);
CREATE INDEX idx_device_access_tokens_hash ON device_access_tokens(token_hash);
CREATE INDEX idx_device_access_tokens_device ON device_access_tokens(device_id);
