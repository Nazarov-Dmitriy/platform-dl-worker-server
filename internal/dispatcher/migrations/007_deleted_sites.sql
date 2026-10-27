ALTER TABLE sites ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1));
INSERT INTO schema_migrations(version) VALUES(7);
