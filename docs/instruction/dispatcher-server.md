# Сервер диспетчера: запуск, копии и обновление

Дата: 2026-10-13. Образ `titunki-dispatcher:stage7`, Compose, health/ready,
снимок SQLite, restore с новой epoch и обслуживание из панели. Не копировать
живой `dispatcher.db`. Не разворачивать исторический config.example.json.

Локальные команды разработки: [dispatcher-development.md](dispatcher-development.md).
Чеклист VPS сайта остаётся в [site-backend-readiness.md](site-backend-readiness.md);
этот документ не меняет production-сайт сам по себе.

## Что нужно на сервере

- Linux с Docker Engine и Compose; допускается основной сервер сайта.
  Ориентир — около 4 CPU и минимум 8 ГБ RAM на весь хост.
- HTTPS-поддомен и reverse proxy с Upgrade для WSS
  ([пример](../../deploy/nginx-dispatcher.conf)).
- Том `/data` вне сменяемого контейнера, каталог локальных копий, отдельный
  бакет/префикс S3 (`DISPATCHER_BACKUP_S3_URI`), не общий с PostgreSQL сайта.

Диспетчер не требует FFmpeg, GPU или моделей.

## Развёртывание

```sh
docker compose build
docker compose run --rm dispatcher init -db /data/dispatcher.db
docker compose run --rm dispatcher owner-bootstrap -db /data/dispatcher.db -login owner -password "choose-a-long-password"
docker compose up -d
docker compose exec dispatcher wget -q -O - http://127.0.0.1:8090/healthz
docker compose exec dispatcher wget -q -O - http://127.0.0.1:8090/readyz
```

Панель: `https://<домен>/panel/` за proxy или `http://127.0.0.1:8090/panel/` на хосте.
Сброс пароля владельца при остановленном контейнере:

```sh
docker compose stop dispatcher
docker compose run --rm dispatcher owner-reset-password -db /data/dispatcher.db -login owner -password "new-long-password"
docker compose up -d
```

Лимиты Compose: 256 MiB RAM, 1 CPU, json-file 10m×3, `restart: unless-stopped`,
read-only root, cap_drop ALL. Стартовый бюджет не считать гарантией до замеров этапа 8.

## Снимки

Процесс раз в сутки (03:00 UTC) делает `VACUUM INTO` в `/data/backups/` и оставляет
семь файлов `dispatcher-*.db`. Владелец может снять копию из панели сразу.
Внешняя копия: переменная `DISPATCHER_BACKUP_S3_URI` (нужен `aws` в образе — по
умолчанию его нет) или скрипт хоста [backup-dispatcher.sh](../../deploy/backup-dispatcher.sh)
/ [backup-dispatcher.ps1](../../deploy/backup-dispatcher.ps1) после появления файлов.

Restore только в отдельной среде или после `docker compose stop`:

```sh
docker compose stop dispatcher
docker compose run --rm dispatcher restore -db /data/dispatcher.db -from /data/backups/dispatcher-YYYYMMDDThhmmssZ.db
docker compose up -d
```

После restore: новая epoch, закрытые назначения, обслуживание включено, старые
результаты устройств с прежним epoch отвергаются. Снимок не обещает задания после него.

## Обновление и откат

1. Панель → Эксплуатация → обслуживание, дождаться `running=0` и `offered=0`.
2. «Подготовить обновление» (снимок, если очередь пуста).
3. Сохранить предыдущий образ: `docker tag titunki-dispatcher:stage7 titunki-dispatcher:previous`.
4. Собрать/подтянуть новый образ, `docker compose up -d`.
5. Совместимый откат образа: вернуть `previous` и `up -d`.
6. Несовместимая схема: `restore` из снимка шага 2, не смешивать WAL живой базы.

Очередь и секреты лежат в томе `/data`; замена контейнера их не стирает.
Обработчик обновляется отдельно на устройстве (`npm ci` / `packaging/package.sh`).
