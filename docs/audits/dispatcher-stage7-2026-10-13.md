# Отчёт этапа 7 — поставка и эксплуатация

Дата: 2026-10-13. Windows, локальные `go test` и Node tests. Образ Compose
`titunki-dispatcher:stage7` на VPS не запускался — это этап 8.

## Сделано

- Runtime-образ копирует `panel/`, ставит `wget`, `HEALTHCHECK /readyz`.
  Compose: том `/data`, 256 MiB / 1 CPU, json-file 10m×3, restart, localhost:8090.
- `/healthz` и `/readyz`; пример WSS proxy `deploy/nginx-dispatcher.conf`.
- Согласованный снимок `VACUUM INTO` в `/data/backups/` (семь копий), суточный
  цикл 03:00 UTC, панель POST `/api/v2/admin/backup`. Опционально
  `DISPATCHER_BACKUP_S3_URI` + aws CLI; хостовые скрипты `deploy/backup-dispatcher.*`.
- `restore -from` на остановленном процессе: новая epoch, закрытие назначений,
  обслуживание. Старые fence отвергаются.
- Владелец: обслуживание, snapshot, update-prepare после нуля running/offered.
  Оператор — 403. Очередь остаётся в томе при замене контейнера.
- Обработчик: `--doctor`, `packaging/package.sh`, install/disable Windows/macOS/Linux,
  Node 22.12+ / образ тестов `node:22.19.0-bookworm-slim`.

## Границы

- `aws` в runtime-образ не входит; внешняя копия — URI на хосте или свой слой образа.
- Restore и CLI к той же БД невозможны, пока `serve` держит flock.
- Автозапуск OS ставит скрипт на устройстве; флаг CONFIGURE сам службу не регистрирует.
- Лимиты 256 MiB/1 CPU — стартовые, не замер production (этап 8).
