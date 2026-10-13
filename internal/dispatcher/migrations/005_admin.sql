CREATE TABLE accounts (
 id TEXT PRIMARY KEY,
 login TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('OWNER','OPERATOR')),
 manage_sites INTEGER NOT NULL,
 enabled INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL
);
CREATE TABLE admin_sessions (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id),
 hash TEXT NOT NULL UNIQUE,
 csrf TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE login_attempts (
 at INTEGER NOT NULL,
 login TEXT NOT NULL,
 ip TEXT NOT NULL,
 success INTEGER NOT NULL
);
CREATE INDEX login_attempts_lookup ON login_attempts(login,ip,at);
CREATE TABLE token_requests (
 request_id TEXT PRIMARY KEY,
 purpose TEXT NOT NULL,
 principal_id TEXT NOT NULL,
 token_id TEXT NOT NULL
);
CREATE TABLE device_identity (
 device_id TEXT PRIMARY KEY REFERENCES devices(id),
 os TEXT NOT NULL DEFAULT '',
 architecture TEXT NOT NULL DEFAULT '',
 accelerators TEXT NOT NULL DEFAULT '[]',
 desired_settings TEXT NOT NULL DEFAULT '',
 reported_settings TEXT NOT NULL DEFAULT ''
);
INSERT INTO schema_migrations(version) VALUES(5);
