# Отслеживание VRAM на устройстве

Обновлено: 2026-11-05. Запланировано.

Родительская задача: [future-tasks.md](../future-tasks.md).

## Цель

Добавить детекшн и отображение видеопамяти (VRAM) в панели устройств. Отдельный план — можно тестировать независимо.

## Задачи

- [ ] **Processor / resources.ts** — добавить `detectVRAM()` для Windows (`nvidia-smi -L` + `--query-gpu=memory.total`) и macOS (`system_profiler SPDisplaysDataType`). Возвращать `{ totalBytes: number, freeBytes: number }`.
- [ ] **Processor / resources.ts** — `Resources.sample()` возвращать `freeVramBytes` вместо `null`.
- [ ] **Processor / agent.ts** — `device.hello` отправлять `vramBytes` (total) и реальные `accelerators: ["cuda"]` / `["metal"]` вместо пустого массива.
- [ ] **Dispatcher / device.go** — добавить `VramBytes int64` в `deviceBody` для `device.hello`.
- [ ] **Dispatcher / scheduler.go** — `Connect()` и `Heartbeat()` сохранять `vram_bytes` в `device_identity`.
- [ ] **Dispatcher / migration 011_vram.sql** — добавить `vram_bytes INTEGER NOT NULL DEFAULT 0` в `device_identity`.
- [ ] **Dispatcher / admin.go** — `AdminDevice()` возвращать `vramBytes` в ответе.
- [ ] **Dispatcher / panel** — отображать VRAM в таблице устройств (столбец рядом с RAM).

## Приёмка

- [ ] На ПК с GPU — определяется CUDA, отправляется total VRAM.
- [ ] На Mac Mini — определяется CPU, VRAM = 0.
- [ ] VRAM отображается в панели устройств рядом с RAM.
