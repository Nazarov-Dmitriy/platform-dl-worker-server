-- The catalog stops carrying a lock and a description nobody asked for, and the
-- pairwise translation models give way to one multilingual model.
CREATE TABLE catalog_seeded (id TEXT PRIMARY KEY) STRICT;
-- Everything already in the catalog counts as offered, so nothing an operator
-- removed earlier comes back on the next start.
INSERT INTO catalog_seeded(id) SELECT DISTINCT id FROM model_catalog;
UPDATE model_catalog SET pinned = 0, note = '';
-- Six languages would have needed thirty of these; NLLB-200 covers them in one.
-- A pair a device still holds is left alone: removing it would leave that
-- device with a model nothing describes.
DELETE FROM model_catalog
 WHERE id LIKE 'opus-mt-%'
   AND NOT EXISTS (SELECT 1 FROM device_models WHERE device_models.model_id = model_catalog.id);
INSERT INTO schema_migrations(version) VALUES(10);
