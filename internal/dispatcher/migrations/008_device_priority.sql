ALTER TABLE devices ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 100);
INSERT INTO schema_migrations(version) VALUES(8);
