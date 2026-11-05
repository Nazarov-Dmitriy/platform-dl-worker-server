# Передача информации об акселераторе

Обновлено: 2026-11-05. Запланировано.

Родительская задача: [future-tasks.md](../future-tasks.md).

## Цель

Передавать на сервер информацию о том, какой акселератор используется (CUDA / Metal / CPU), чтобы владелец видел, на чём идёт обработка. Отдельный план — можно тестировать независимо.

## Задачи

- [ ] **Processor / agent.ts** — в `usage()` передавать `acceleratorUsed` (строка: `"none"`, `"cuda"`, `"metal"`) — на каком движке идёт обработка.
- [ ] **Dispatcher / protocol.go** — добавить `acceleratorUsed` в `Usage` (или в `reported_settings` device_identity).
- [ ] **Dispatcher / scheduler.go** — `Heartbeat()` обновлять `reported_settings` с текущим акселератором.
- [ ] **Dispatcher / admin.go** — `AdminDevice()` возвращать `acceleratorUsed`.
- [ ] **Dispatcher / panel** — отображать "Используется: CUDA / CPU" в карточке устройства.

## Приёмка

- [ ] Сервер показывает "Используется: CUDA" / "CPU" в карточке устройства.
- [ ] Владелец видит, на чём идёт обработка.
