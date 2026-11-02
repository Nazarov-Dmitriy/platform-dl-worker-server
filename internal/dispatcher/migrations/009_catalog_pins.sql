ALTER TABLE model_catalog ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1));
ALTER TABLE model_catalog ADD COLUMN note TEXT NOT NULL DEFAULT '';
UPDATE model_catalog SET pinned=1, note='Базовая модель распознавания речи. Обслуживает задания «Распознавание речи» и «Субтитры».'
 WHERE id IN ('whisper-cpp-base', 'whisper-cpp-small');
UPDATE model_catalog SET pinned=1, note='Базовая пара перевода. Обслуживает задания «Субтитры».'
 WHERE id IN ('opus-mt-en-ru-q8', 'opus-mt-ru-en-q8');
INSERT INTO schema_migrations(version) VALUES(9);
