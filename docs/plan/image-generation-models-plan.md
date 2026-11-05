# Генерация изображений: каталог моделей и executor

Обновлено: 2026-11-05. Запланировано.

Родительская задача: [future-tasks.md](../future-tasks.md).

## Цель

Добавить модели генерации фотографий (Realistic Vision V5.1 + FLUX.1-schnell) и executor для запуска генерации на воркере. Отдельный план — можно тестировать независимо.

## Задачи

### Этап 1 — каталог моделей

- [ ] **Dispatcher / catalog.go** — добавить seed-модели:
  - `realistic-vision-v51` (SD 1.5, ~2 ГБ, min 4 ГБ VRAM / 6 ГБ RAM, CPU-friendly, Open RAIL-M)
  - `flux-schnell-q4` (FLUX.1-schnell GGUF Q4_K_S, ~7 ГБ, min 12 ГБ VRAM, Apache 2.0)
- [ ] **Dispatcher / catalog.go** — определить новый `executor: "diffusers"` (или `"ggml"` для GGUF) и `purpose: "GENERATION"`.
- [ ] **Dispatcher / catalog_admin.go** — `buildCatalogEntry` для `GENERATION` — устанавливать executor, accelerators, minimumVramBytes.
- [ ] **Processor / models.ts** — разрешить executor `diffusers` / `ggml` в `modelReady()`.
- [ ] **Processor / models.ts** — `modelReady()` для `diffusers`: проверка наличия `transformers` / `torch` / `onnxruntime`.
- [ ] **Processor / journal.ts** — добавить `generationModel` в `InstalledModel` (purpose: `"GENERATION"`).
- [ ] **Processor / catalog.ts** — добавить встроенные каталоги для `realistic-vision-v51` и `flux-schnell-q4` (ссылки на HF, размеры, хеши).

### Этап 2 — executor генерации

- [ ] **Processor / generate-child.ts** (NEW) — executor для генерации изображений. Получает `start` с: `prompt`, `model`, `params` (size, steps, seed), `outDir`. Запускает модель (diffusers / ONNX / GGML). Отправляет `progress` (шаги), `generated` (пути к файлам), `failed`.
- [ ] **Processor / agent.ts** — `runJob()`: ветка `job.type === "media.generate"` — выбор модели, спавн `generate-child`, сбор артефактов.
- [ ] **Processor / agent.ts** — `caps()`: объявлять `media.generate` если активна модель генерации.
- [ ] **Processor / agent.ts** — local admission check: проверка VRAM/RAM перед запуском.
- [ ] **Processor / config.ts** — добавить `generationMode` (cpu / cuda / metal).
- [ ] **Contracts / protocol.schema.json** — добавить `media.generate` job type: `prompt`, `imageCount`, `width`, `height`, `steps`, `seed`.
- [ ] **Dispatcher / protocol.go** — добавить `"GENERATING"` в валидацию стадий.

### Этап 3 — фронт / курс

- [ ] **Курс / UI** — экран генерации: поле промпта, кнопка "Сгенерировать", превью результата.
- [ ] **Курс / UI** — img2img: загрузка референса + промпт для доработки.
- [ ] **Курс / UI** — заглушка "Генерация недоступна" если нет устройств с GPU.
- [ ] **Desktop / UI** — экран генерации в приложении (статус, выбранная модель, VRAM).
- [ ] **Desktop / processing.cjs** — валидация настроек генерации.

## Приёмка

- [ ] На устройстве с GPU — доступна модель FLUX.1-schnell.
- [ ] На устройстве без GPU — доступна только Realistic Vision V5.1.
- [ ] Генерация запускается, прогресс показывается, результат сохраняется.
- [ ] При отсутствии доступных устройств — показывается заглушка.
- [ ] **Desktop** — поля статуса генерации читаемы.
- [ ] **Mobile** — веб-панель устройств показывает VRAM.