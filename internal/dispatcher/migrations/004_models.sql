CREATE TABLE model_catalog (
 id TEXT NOT NULL,
 revision TEXT NOT NULL,
 entry BLOB NOT NULL,
 PRIMARY KEY(id, revision)
);
CREATE TABLE device_models (
 device_id TEXT NOT NULL REFERENCES devices(id),
 model_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('INSTALLED','ACTIVE')),
 PRIMARY KEY(device_id, model_id, revision)
);
CREATE TABLE device_commands (
 request_id TEXT PRIMARY KEY,
 device_id TEXT NOT NULL REFERENCES devices(id),
 fingerprint TEXT NOT NULL,
 body BLOB NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
 progress REAL,
 error BLOB,
 created_at INTEGER NOT NULL,
 notified INTEGER NOT NULL DEFAULT 0
);
INSERT INTO schema_migrations(version) VALUES(4);
