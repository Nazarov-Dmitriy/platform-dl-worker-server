CREATE TABLE device_messages (
 principal_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(principal_id,message_id)
);
INSERT INTO schema_migrations(version) VALUES(2);
